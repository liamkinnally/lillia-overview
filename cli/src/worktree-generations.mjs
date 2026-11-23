// Runs only through the fixed local Darwin Python interpreter in isolated mode.
export const generationWorker = String.raw`"""Read APFS generation and identity together on safe descriptors (Darwin getattrlist)."""
from contextlib import closing
import ctypes
import json
import os
import stat
import select
import struct
import sys

lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
attributes = ctypes.create_string_buffer(struct.pack('=HH5I', 5, 0, 0x80000, 0, 0, 0, 0))
def watch_metadata():
    # File data generation excludes permission changes. Keep vnode watches
    # armed across every clone so even intervening chmod and restore is seen.
    paths = json.loads(sys.stdin.readline())
    fds = []
    identities = []
    try:
        with closing(select.kqueue()) as queue:
            binding = select.KQ_NOTE_RENAME | select.KQ_NOTE_DELETE | select.KQ_NOTE_REVOKE
            for path in paths:
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | 0x20000000)
                except FileNotFoundError:
                    identities.append(None)
                    continue
                fds.append(fd)
                info = os.fstat(fd)
                identities.append([str(info.st_dev), str(info.st_ino)])
                if stat.S_ISREG(info.st_mode):
                    notes = binding | select.KQ_NOTE_ATTRIB | select.KQ_NOTE_LINK
                elif stat.S_ISDIR(info.st_mode):
                    notes = binding
                else:
                    return 1
                event = select.kevent(fd, filter=select.KQ_FILTER_VNODE,
                                      flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=notes)
                queue.control([event], 0, 0)
            print(json.dumps(identities), flush=True)
            if sys.stdin.readline() != 'finish\n':
                return 1
            return 1 if queue.control(None, len(fds), 0) else 0
    finally:
        for fd in fds:
            os.close(fd)


if sys.argv[1:] == ['watch']:
    sys.exit(watch_metadata())

observations = {}
try:
    for path in json.load(sys.stdin):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | 0x20000000)  # O_NOFOLLOW_ANY
        except FileNotFoundError:
            observations[path] = None
            continue
        try:
            info = os.fstat(fd)
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError('unsupported object')
            result = ctypes.create_string_buffer(8)
            if lib.fgetattrlist(fd, attributes, result, 8, 0x20):
                raise OSError(ctypes.get_errno(), 'generation unavailable')
            size, generation = struct.unpack('=II', result.raw)
            if size != 8 or generation == 0:
                raise ValueError('unavailable or mapped object')
            observations[path] = [str(info.st_dev), str(info.st_ino), generation, info.st_mode,
                                  str(info.st_ctime_ns) if stat.S_ISREG(info.st_mode) else None]
        finally:
            os.close(fd)
    print(json.dumps(observations, separators=(',', ':')))
except (OSError, ValueError):
    sys.exit(1)
`;
