import { createHash, randomUUID } from 'node:crypto';
import { Investigations } from './investigations.mjs';

function requireValue(condition, message, status = 409) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validDestination = (name) => name === 'claude' || name === 'codex';
const validOperation = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

export function installResearchDisclosures(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS research_disclosures (
    id TEXT PRIMARY KEY, investigationId TEXT NOT NULL REFERENCES investigation_runs(id),
    digest TEXT NOT NULL, forOperation TEXT NOT NULL, destinations TEXT NOT NULL,
    grantedAt TEXT NOT NULL, revokedAt TEXT
  )`);
}

export class ResearchDisclosures {
  constructor(store) {
    this.db = store.db;
    this.investigations = new Investigations(store);
  }
  preview(investigationId) {
    const run = this.investigations.show({ id: investigationId });
    // Only values from the fixed experiment and its fixed decision template
    // cross the provider boundary. User prose, raw code and catalog text stay local.
    const material = {
      version: 1,
      method: run.method,
      outcome: run.outcome,
      decision: run.decision,
      limitation: run.limitation
    };
    const source = {
      investigationId,
      revision: run.source.revision,
      sourceDigest: run.source.digest,
      catalog: run.catalog.version,
      passageDigest: run.catalog.digest,
      recordDigest: this.db
        .prepare('SELECT digest FROM investigation_runs WHERE id=?')
        .get(investigationId).digest
    };
    return { source, material, digest: hash({ source, material }) };
  }
  grant({ investigationId, digest, forOperation, destinations }) {
    requireValue(
      this.db.isTransaction,
      'Granting a disclosure requires an owner receipt transaction.'
    );
    requireValue(
      validOperation(forOperation) &&
        Array.isArray(destinations) &&
        destinations.length > 0 &&
        destinations.length <= 2 &&
        destinations.every(validDestination) &&
        new Set(destinations).size === destinations.length,
      'Supply the target operation and distinct provider destinations.',
      400
    );
    const preview = this.preview(investigationId);
    requireValue(
      preview.digest === digest,
      'Inspect the current evidence projection before granting it.'
    );
    const id = randomUUID(),
      time = new Date().toISOString();
    this.db
      .prepare('INSERT INTO research_disclosures VALUES(?,?,?,?,?,?,NULL)')
      .run(
        id,
        investigationId,
        digest,
        forOperation,
        JSON.stringify([...destinations].sort()),
        time
      );
    return this.show(id);
  }
  show(id) {
    requireValue(
      typeof id === 'string' && id.length > 0 && id.length <= 128,
      'Invalid research grant ID.',
      400
    );
    const row = this.db.prepare('SELECT * FROM research_disclosures WHERE id=?').get(id);
    requireValue(row, 'Research disclosure grant not found.', 404);
    return {
      ...row,
      destinations: JSON.parse(row.destinations),
      state: row.revokedAt ? 'revoked' : 'active'
    };
  }
  revoke(id) {
    requireValue(
      this.db.isTransaction,
      'Revoking a disclosure requires an owner receipt transaction.'
    );
    this.show(id);
    this.db
      .prepare('UPDATE research_disclosures SET revokedAt=? WHERE id=? AND revokedAt IS NULL')
      .run(new Date().toISOString(), id);
    return this.show(id);
  }
  use(id, operationId, destinations) {
    const grant = this.show(id);
    requireValue(grant.state === 'active', 'Research disclosure has been revoked.');
    return this.historical(id, operationId, destinations);
  }
  historical(id, operationId, destinations) {
    const grant = this.show(id);
    requireValue(
      grant.forOperation === operationId &&
        destinations.length > 0 &&
        destinations.every((d) => validDestination(d) && grant.destinations.includes(d)),
      'The current research grant does not authorize this operation and its destinations.'
    );
    const preview = this.preview(grant.investigationId);
    requireValue(
      grant.digest === preview.digest,
      'The granted evidence differs from the current projection.'
    );
    return { ...preview, grantId: grant.id };
  }
}

export function researchForDevelopment(store, input, operationId, { historical = false } = {}) {
  if (!input.researchGrantId) return null;
  const policy = new ResearchDisclosures(store),
    destinations = [input.authorProvider, input.reviewerProvider];
  return historical
    ? policy.historical(input.researchGrantId, operationId, destinations)
    : policy.use(input.researchGrantId, operationId, destinations);
}
export function researchPin(disclosure) {
  return disclosure
    ? { grantId: disclosure.grantId, digest: disclosure.digest, source: disclosure.source }
    : null;
}

export function researchForRole(store, taskId) {
  let row = store.db
    .prepare(
      `SELECT f.admission,f.operationId,d.provider,d.role FROM change_delegations d
    JOIN change_flows f ON f.goalId=d.goalId WHERE d.taskId=?`
    )
    .get(taskId);
  if (!row && store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='native_roles'").get())
    row = store.db
      .prepare(
        `SELECT f.admission,f.operationId,g.provider,r.role FROM native_roles r JOIN native_goals f ON f.goalId=r.goalId
      JOIN goal_tasks g ON g.taskId=r.taskId AND g.goalId=r.goalId WHERE r.taskId=?`
      )
      .get(taskId);
  if (!row) return null;
  const input = JSON.parse(row.admission);
  if (!input.researchGrantId) return null;
  requireValue(
    input[row.role + 'Provider'] === row.provider,
    'Research grant destination differs from the admitted role.'
  );
  return researchForDevelopment(store, input, row.operationId);
}

export function assertResearchAuthority(store, taskId) {
  // Standalone TaskStore installations do not admit development roles.
  const db = store.db;
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='change_delegations'")
      .get()
  )
    return;
  const disclosure = researchForRole(store, taskId);
  if (!disclosure) return;
  const native =
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='native_roles'").get() &&
    db.prepare('SELECT 1 FROM native_roles WHERE taskId=?').get(taskId);
  const roles = native ? 'native_roles' : 'change_delegations',
    flows = native ? 'native_goals' : 'change_flows';
  const row = db
    .prepare(
      `SELECT r.role,r.cycle,f.cycle AS currentCycle,f.stage,f.authorTaskId,f.reviewerTaskId,f.scopeVersion,
    g.state,gt.goalId FROM ${roles} r JOIN ${flows} f ON f.goalId=r.goalId JOIN goals g ON g.id=f.goalId
    JOIN goal_tasks gt ON gt.taskId=r.taskId AND gt.goalId=f.goalId WHERE r.taskId=?`
    )
    .get(taskId);
  requireValue(
    row &&
      row.state === 'active' &&
      row.stage === row.role &&
      row.cycle === row.currentCycle &&
      row[row.role + 'TaskId'] === taskId &&
      store.goal(row.goalId).scopeVersion === row.scopeVersion,
    'Research-bearing role no longer owns this active goal scope.'
  );
  const ctx = db
    .prepare(
      'SELECT x.manifest FROM task_contexts x JOIN attempts a ON a.taskId=x.taskId AND a.ordinal=x.ordinal WHERE x.taskId=? ORDER BY a.ordinal DESC LIMIT 1'
    )
    .get(taskId);
  requireValue(
    ctx &&
      JSON.stringify(JSON.parse(ctx.manifest).research) === JSON.stringify(researchPin(disclosure)),
    'Research disclosure differs from its reserved evidence.'
  );
}
