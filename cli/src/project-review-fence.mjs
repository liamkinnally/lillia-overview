import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fsyncSync,
  renameSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateFile, privateRoot } from './installation-gate.mjs';
import { callService } from './local-client.mjs';

function need(ok, message) {
  if (!ok) throw Object.assign(Error(message), { status: 409 });
}

function binding(dataDir, workspaceRoot, operationId, input) {
  const dir = privateRoot(realpathSync(dataDir));
  const file = lstatSync(join(dir, 'platform.sqlite'), { bigint: true });
  need(
    file.isFile() && file.nlink === 1n && file.uid === BigInt(process.getuid()),
    'Unexpected project database.'
  );
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        dir,
        realpathSync(workspaceRoot),
        String(file.dev),
        String(file.ino),
        operationId,
        input
      ])
    )
    .digest('hex');
  return { dir, digest, file: join(dir, 'review-stop-' + digest + '.json') };
}
function readRecord(bound, file = bound.file) {
  try {
    const r = JSON.parse(privateFile(file, 2048));
    need(
      r.digest === bound.digest &&
        /^[a-f0-9-]{36}$/.test(r.predecessorId) &&
        r.cutoff === 'review.' + r.digest + '.' + r.predecessorId &&
        Number.isSafeInteger(r.generation) &&
        r.generation > 0 &&
        Number.isSafeInteger(r.pid) &&
        r.pid > 1,
      'Unexpected project reviewer stop acknowledgment.'
    );
    return r;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function record(bound, file, entry) {
  // The owner-private directory and named drain bind concurrent supervisors to one predecessor.
  const prior = readRecord(bound, file);
  if (prior) {
    need(JSON.stringify(prior) === JSON.stringify(entry), 'Another predecessor was recorded.');
    return;
  }
  const temp = join(bound.dir, '.review-stop-' + randomUUID());
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(entry));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const parent = openSync(bound.dir, constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
// PID reuse can only defer recovery: the alternative witness requires ESRCH.
function stoppedPredecessor(bound) {
  const acknowledged = readRecord(bound);
  if (acknowledged) return acknowledged;
  const pending = readRecord(bound, bound.file + '.pending');
  if (pending) {
    try {
      process.kill(pending.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pending;
      throw error;
    }
  }
  return null;
}
function isolated(view, input) {
  const c = view.counts;
  return (
    c.uncertainTasks === 1 &&
    c.unconfirmedControls === 1 &&
    [
      'queuedTasks',
      'activeTasks',
      'inFlight',
      'workers',
      'callbacks',
      'liveControls',
      'pendingEffects',
      'pendingControls',
      'uncertainWorkspaces'
    ].every((k) => c[k] === 0) &&
    view.sample.tasks[0]?.id === input.taskId &&
    view.sample.controls[0]?.id === 'active-time/' + input.attemptId
  );
}
export function projectReviewerFence({
  dataDir,
  workspaceRoot,
  operationId,
  input,
  serviceWriter,
  drain,
  broker
}) {
  const held = stoppedPredecessor(binding(dataDir, workspaceRoot, operationId, input));
  const writer = serviceWriter?.();
  const cutoff = drain.view();
  need(
    held &&
      writer &&
      held.predecessorId !== writer &&
      cutoff.mode === 'draining' &&
      cutoff.cutoff === held.cutoff &&
      cutoff.generation === held.generation,
    'The stopped reviewer must be fenced by its named drain and a new exclusive service writer.'
  );
  return {
    predecessorId: held.predecessorId,
    successorId: writer,
    priorProcessStopped: true,
    exclusiveWriter: true,
    ...broker
  };
}

export async function superviseProjectReview(
  { dataDir, workspaceRoot },
  { input, operationId },
  { daemonStatus, ensureDaemon }
) {
  const bound = binding(dataDir, workspaceRoot, operationId, input);
  const rpc = async (name, fields = {}, id) =>
    (
      await callService(dataDir, {
        name,
        input: fields,
        operationId: id,
        workspaceRoot: realpathSync(workspaceRoot)
      })
    ).result;
  let stop = stoppedPredecessor(bound);
  if (!stop) {
    const old = await daemonStatus(dataDir);
    need(
      old.running && old.workspaceRoot === realpathSync(workspaceRoot),
      'The original project service must be running.'
    );
    // A conflicting operation ID must fail before the supervisor changes the running service.
    let existing;
    try {
      existing = await rpc('operation', { id: operationId });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (existing) {
      need(
        existing.receipt?.recovery?.goalId === input.goalId,
        'Operation ID already belongs to another request.'
      );
      const receipt = await rpc('project.review.retry', input, operationId);
      const drain = await rpc('daemon.drain-status');
      need(
        drain.mode !== 'draining' ||
          drain.cutoff !== 'review.' + bound.digest + '.' + receipt.recovery.fence.predecessorId,
        'The stop acknowledgment is missing for this pending resume.'
      );
      return receipt;
    }
    const [goal, task, drain] = await Promise.all([
      rpc('goal', { id: input.goalId }),
      rpc('task', { id: input.taskId }),
      rpc('daemon.drain-status')
    ]);
    need(
      goal.projectChange?.stage === 'reviewer' &&
        goal.projectChange.reviewerTaskId === input.taskId &&
        goal.projectChange.candidate === input.candidate &&
        task.task?.status === 'recovery_needed' &&
        task.attempts?.length === 1 &&
        task.attempts[0].id === input.attemptId &&
        isolated(drain, input),
      'Only the named uncertain project reviewer and its expired reservation may be present.'
    );
    const cutoff = 'review.' + bound.digest + '.' + old.instanceId;
    need(drain.mode === 'open' || drain.cutoff === cutoff, 'Another named drain is in effect.');
    if (drain.mode === 'open')
      await rpc('daemon.drain', { expectedGeneration: drain.generation }, cutoff);
    // Recheck after dispatch admission has closed. The old writer drains pending RPCs
    // and destroys its job credentials before acknowledging its instance-bound stop.
    const current = await rpc('daemon.drain-status');
    need(
      current.cutoff === cutoff && isolated(current, input),
      'The reviewer is no longer isolated at the named cutoff.'
    );
    const entry = {
      digest: bound.digest,
      predecessorId: old.instanceId,
      pid: old.pid,
      cutoff,
      generation: current.generation
    };
    record(bound, bound.file + '.pending', entry);
    const acknowledged = await rpc('daemon.stop', { instanceId: old.instanceId });
    need(
      acknowledged.instanceId === old.instanceId && acknowledged.pid === old.pid,
      'The predecessor did not acknowledge its stop.'
    );
    record(bound, bound.file, entry);
    stop = entry;
  }
  for (let i = 0; i < 100 && (await daemonStatus(dataDir)).instanceId === stop.predecessorId; i++)
    await delay(50);
  const next = await ensureDaemon(dataDir, workspaceRoot);
  need(next.instanceId !== stop.predecessorId, 'The predecessor still owns the service.');
  // Exact operation replay precedes the cutoff check inside the daemon. A lost reply
  // can therefore finish the original resume without granting any more time or attempts.
  const receipt = await rpc('project.review.retry', input, operationId);
  const drain = await rpc('daemon.drain-status');
  if (drain.cutoff === stop.cutoff && drain.generation === stop.generation)
    await rpc(
      'daemon.resume',
      { cutoff: stop.cutoff, expectedGeneration: stop.generation },
      'resume.' + bound.digest
    );
  return receipt;
}
