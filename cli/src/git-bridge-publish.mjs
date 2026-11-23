// Invoked only by the bridge with its saved directory inode as this process's cwd.
import {
  constants as C,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  statSync
} from 'node:fs';
import { sha256 } from './git-bridge-format.mjs';
try {
  const [mode, stage, file, device, inode, sourceDevice, sourceInode, digest, size] =
    process.argv.slice(2);
  const dir = statSync('.', { bigint: true });
  if (
    String(dir.dev) !== device ||
    String(dir.ino) !== inode ||
    !file ||
    file.includes('/') ||
    file === '.' ||
    file === '..'
  )
    throw Error();
  function check(name) {
    const fd = openSync(name, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const st = fstatSync(fd, { bigint: true });
      if (
        !st.isFile() ||
        String(st.dev) !== sourceDevice ||
        String(st.ino) !== sourceInode ||
        String(st.size) !== size ||
        sha256(readFileSync(fd)) !== digest
      )
        throw Error();
    } finally {
      closeSync(fd);
    }
  }
  check(stage);
  if (mode === 'publish') linkSync(stage, file);
  else if (mode !== 'reconcile') throw Error();
  check(file);
  const dirfd = openSync('.', C.O_RDONLY | C.O_DIRECTORY);
  try {
    fsyncSync(dirfd);
  } finally {
    closeSync(dirfd);
  }
} catch {
  process.exitCode = 1;
}
