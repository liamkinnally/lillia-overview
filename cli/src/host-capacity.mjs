import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { diskShortfall } from './lib/portable/disk-shortfall.cjs';

export const MiB = 1024 * 1024;
const diskFloor = 10 * 1024 * MiB;
const memoryFloor = 3 * 1024 * MiB;
const workerReservation = 64 * MiB;
const estimates = new Map([
  ['project.develop', workerReservation],
  ['project.repair', workerReservation],
  ['project.validation.enroll', 768 * MiB],
  ['project.validation.check', 768 * MiB],
  ['goal.develop', workerReservation],
  ['task.submit', workerReservation],
  ['goal.run', workerReservation],
  ['project.register', 256 * MiB],
  ['research.import', 128 * MiB],
  ['research.run', 16 * MiB],
  ['research.fetch', 4 * MiB],
  ['release.bisect', 64 * MiB],
  ['release.prepare', 16 * MiB],
  ['compat.inspect', workerReservation],
  ['compat.probe', 32 * MiB],
  ['compat.open', 32 * MiB],
  ['compat.submit', 32 * MiB],
  ['native.draft.update', 8 * MiB],
  ['bridge.import', 256 * MiB],
  ['bridge.export', 256 * MiB],
  ['worktree.preview', 256 * MiB],
  ['worktree.capture', 256 * MiB],
  ['workspace.validate', workerReservation],
  ['review.attest', workerReservation],
  ['authority.migrate', 256 * MiB],
  ['review.init', 128 * MiB],
  ['review.submit', 256 * MiB],
  ['review.check', 256 * MiB],
  ['review.land', 256 * MiB]
]);
const noRelease = () => {};

function sampleHost(dataDir) {
  const disk = statfsSync(dataDir),
    totalMemory = totalmem();
  let memoryPercent, memorySource;
  if (process.platform === 'darwin') {
    const output = execFileSync('/usr/bin/memory_pressure', ['-Q'], {
      encoding: 'utf8',
      timeout: 1500,
      maxBuffer: 8192,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const match = output.match(/System-wide memory free percentage:\s*(\d+)%/);
    if (!match) throw Error('macOS memory reading unavailable');
    memoryPercent = Number(match[1]);
    memorySource = 'macOS memory_pressure -Q';
  } else {
    memoryPercent = Math.floor((100 * freemem()) / totalMemory);
    memorySource = 'OS free physical memory';
  }
  return { diskAvailable: disk.bavail * disk.bsize, totalMemory, memoryPercent, memorySource };
}

export class HostCapacity {
  constructor({ dataDir, sample = () => sampleHost(dataDir), workers }) {
    this.sample = sample;
    this.workers = workers;
    this.pendingBytes = 0;
    this.nextSample = 0;
    this.observation = null;
  }
  status(extraBytes = 0) {
    if (performance.now() >= this.nextSample || this.observation === null) {
      this.nextSample = performance.now() + 2000;
      try {
        this.observation = { ...this.sample(), at: new Date().toISOString() };
      } catch {
        this.observation = { at: new Date().toISOString() };
      }
    }
    const { diskAvailable, totalMemory, memoryPercent } = this.observation;
    const reservedBytes = this.pendingBytes + this.workers() * workerReservation;
    const requiredPercent = totalMemory > 0 ? Math.ceil((100 * memoryFloor) / totalMemory) : null;
    const measuredDisk = Number.isSafeInteger(diskAvailable) && diskAvailable >= 0;
    const diskShortfallBytes = measuredDisk
      ? diskShortfall(diskAvailable, diskFloor, reservedBytes, extraBytes)
      : null;
    const validationShortfallBytes = measuredDisk
      ? diskShortfall(diskAvailable, diskFloor, reservedBytes, estimates.get('review.check'))
      : null;
    let blocker = null;
    if (
      !Number.isSafeInteger(diskAvailable) ||
      diskAvailable < 0 ||
      !Number.isSafeInteger(totalMemory) ||
      totalMemory <= 0 ||
      !Number.isFinite(memoryPercent) ||
      memoryPercent < 0 ||
      memoryPercent > 100
    )
      blocker =
        'Host capacity could not be measured. Inspect the local volume and memory telemetry.';
    else if (diskAvailable - reservedBytes - extraBytes < diskFloor)
      blocker =
        'The data volume needs ' +
        diskShortfallBytes +
        ' more bytes for this operation above the 10 GiB reserve.';
    else if (memoryPercent < requiredPercent)
      blocker = 'System memory is below the admission threshold. Retry when memory pressure eases.';
    return {
      ...this.observation,
      diskReserveBytes: diskFloor,
      memoryThresholdPercent: requiredPercent,
      reservedBytes,
      requestedBytes: extraBytes,
      diskShortfallBytes,
      validationShortfallBytes,
      blocker
    };
  }
  workerAvailable() {
    return this.status(workerReservation).blocker === null;
  }
  operationAvailable(name) {
    return this.status(estimates.get(name) ?? 0).blocker === null;
  }
  reserve(operation) {
    const bytes = estimates.get(operation);
    if (!bytes) return noRelease;
    const { blocker } = this.status(bytes);
    if (blocker) throw Object.assign(Error(blocker), { status: 409 });
    this.pendingBytes += bytes;
    let released = false;
    return () => {
      if (!released) this.pendingBytes -= bytes;
      released = true;
    };
  }
}
