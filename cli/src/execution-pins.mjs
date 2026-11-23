import { createHash } from 'node:crypto';
import { normalizeExecutionPin, resolveExecutionSelection } from './execution-selection.mjs';

const fail = () => {
  throw Object.assign(new Error('Execution selection evidence is invalid.'), { status: 409 });
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const executionPinTable = 'owner_execution_pins';
const executionPinSQL = `CREATE TABLE owner_execution_pins(
    kind TEXT NOT NULL CHECK(kind IN ('goal','task')),subjectId TEXT NOT NULL,
    operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY(kind,subjectId)
  )`;

function subject(receipt) {
  if (receipt?.executionPin === undefined) {
    if (
      receipt?.operationId &&
      ['goal', 'task'].some(
        (kind) => receipt[kind]?.executionSelection?.operationId === receipt.operationId
      )
    )
      fail();
    return null;
  }
  const proof = receipt.executionPin;
  const kind =
    proof?.command === 'goal.create' ? 'goal' : proof?.command === 'task.submit' ? 'task' : null;
  if (proof?.kind !== 'owner-execution-pin-v1' || !kind || typeof receipt[kind]?.id !== 'string')
    fail();
  return { kind, id: receipt[kind].id };
}

export function installExecutionPins(db) {
  db.exec(executionPinSQL);
  // Backfill once, inside the migration transaction. Unreadable retained proofs
  // cannot establish which subject was selected, so migration must fail closed.
  try {
    const insert = db.prepare('INSERT INTO owner_execution_pins VALUES(?,?,?)');
    for (const row of db.prepare('SELECT operationId,receipt FROM command_receipts').iterate()) {
      const receipt = JSON.parse(row.receipt);
      if (receipt?.operationId !== row.operationId) fail();
      const selected = subject(receipt);
      if (selected) insert.run(selected.kind, selected.id, row.operationId);
    }
  } catch {
    fail();
  }
}

export function verifyExecutionPins(db) {
  if (
    db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(executionPinTable)
      ?.sql !== executionPinSQL
  )
    fail();
  let pins = 0;
  for (const { kind, subjectId } of db
    .prepare('SELECT kind,subjectId FROM owner_execution_pins')
    .iterate()) {
    if (!readExecutionPin(db, kind, subjectId)) fail();
    pins++;
  }
  try {
    for (const row of db.prepare('SELECT operationId,receipt FROM command_receipts').iterate()) {
      const receipt = JSON.parse(row.receipt);
      if (receipt?.operationId !== row.operationId) fail();
      const selected = subject(receipt);
      if (
        selected &&
        db
          .prepare('SELECT operationId FROM owner_execution_pins WHERE kind=? AND subjectId=?')
          .get(selected.kind, selected.id)?.operationId !== row.operationId
      )
        fail();
    }
  } catch {
    fail();
  }
  return { pins };
}

export function resolveStoredExecution(
  store,
  selection,
  goal,
  expectedVersion,
  roleProvider,
  projectExecution = false
) {
  if (!store.db.isTransaction)
    throw Object.assign(new Error('Execution selection requires the owner transaction.'), {
      status: 409
    });
  return resolveExecutionSelection({
    selection: {
      ...normalizeExecutionPin(selection),
      ...(goal ? { goalId: goal.id, expectedVersion } : {})
    },
    goal,
    sessionProfile: store.sessionProfile,
    adapters: store.executionAdapters?.(),
    roleProvider,
    projectExecution
  });
}

// Owner receipts already participate in the same transaction and every recovery archive.
// Do not add a second mutable model setting or revalidate historical pins against today's account.
export function executionReceipt(command, input, operationId, kind, value, db) {
  if (!input.executionSelection) return { [kind]: value };
  if (!db?.isTransaction || db.prepare('PRAGMA user_version').get().user_version < 56) fail();
  db.prepare('INSERT INTO owner_execution_pins VALUES(?,?,?)').run(kind, value.id, operationId);
  return {
    [kind]: {
      ...value,
      executionSelection: {
        ...value.executionSelection,
        origin: 'owner-selection',
        operationId
      }
    },
    executionPin: { kind: 'owner-execution-pin-v1', command, input }
  };
}

export function readExecutionPin(db, kind, id) {
  if (!['goal', 'task'].includes(kind)) fail();
  if (db.prepare('PRAGMA user_version').get().user_version < 56) return null;
  const row = db
    .prepare(
      `SELECT p.operationId,r.digest,r.receipt FROM owner_execution_pins p
    LEFT JOIN command_receipts r ON r.operationId=p.operationId WHERE p.kind=? AND p.subjectId=?`
    )
    .get(kind, id);
  if (!row) return null;
  try {
    const receipt = JSON.parse(row.receipt),
      proof = receipt.executionPin;
    const selected = subject(receipt);
    if (selected?.kind !== kind || selected.id !== id) fail();
    const pin = normalizeExecutionPin(proof.input.executionSelection);
    const command = kind === 'goal' ? 'goal.create' : 'task.submit';
    const expected = {
      ...pin,
      ...(kind === 'task'
        ? { goalId: proof.input.goalId, expectedVersion: proof.input.expectedVersion }
        : {}),
      entitlement: 'unconfirmed',
      origin: 'owner-selection',
      operationId: row.operationId
    };
    if (
      proof.command !== command ||
      row.digest !== hash([command, proof.input]) ||
      receipt.operationId !== row.operationId ||
      JSON.stringify(receipt[kind].executionSelection) !== JSON.stringify(expected)
    )
      fail();
    if (kind === 'goal') {
      const goal = db
        .prepare(
          `SELECT d.workerProvider,p.model FROM goal_destinations d
        LEFT JOIN goal_model_pins p ON p.goalId=d.goalId WHERE d.goalId=?`
        )
        .get(id);
      if (
        goal?.workerProvider !== pin.provider ||
        (pin.provider === 'claude' && goal.model !== pin.model)
      )
        fail();
    } else {
      const task = db
        .prepare(
          `SELECT t.model,g.provider,g.goalId,g.goalVersion FROM tasks t
        JOIN goal_tasks g ON g.taskId=t.id WHERE t.id=?`
        )
        .get(id);
      if (
        task?.model !== pin.model ||
        task.provider !== pin.provider ||
        task.goalId !== expected.goalId ||
        task.goalVersion !== expected.expectedVersion
      )
        fail();
    }
    return expected;
  } catch {
    fail();
  }
}
