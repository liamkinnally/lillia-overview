import { createHash } from 'node:crypto';

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
function fields(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail('Invalid mail fields.', 400);
}
function text(value, limit = 1600) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    fail('Invalid mail text or identity.', 400);
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('Invalid thread version.', 400);
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function createEnvelope(input) {
  fields(input, ['operationId', 'projectId', 'sender', 'recipient', 'selection']);
  fields(input.sender, ['threadId', 'version']);
  fields(input.recipient, ['threadId', 'version']);
  fields(input.selection, ['text', 'source']);
  fields(input.selection.source, ['turnId', 'revision', 'start', 'end']);
  const { source } = input.selection;
  if (
    !Number.isSafeInteger(source.start) ||
    !Number.isSafeInteger(source.end) ||
    source.start < 0 ||
    source.end <= source.start
  )
    fail('Invalid source range.', 400);
  return freeze({
    operationId: text(input.operationId, 128),
    projectId: text(input.projectId, 128),
    sender: { threadId: text(input.sender.threadId, 128), version: version(input.sender.version) },
    recipient: {
      threadId: text(input.recipient.threadId, 128),
      version: version(input.recipient.version)
    },
    selection: {
      text: text(input.selection.text),
      source: {
        turnId: text(source.turnId, 128),
        revision: text(source.revision, 128),
        start: source.start,
        end: source.end
      }
    }
  });
}
const digest = (envelope) => createHash('sha256').update(JSON.stringify(envelope)).digest('hex');

// Adapter methods execute synchronously inside one durable transaction. Authorization and
// source reads must use the same authoritative snapshot as inserts and updates.
// confirmReceipt must bind the immutable envelope, attempt and digest to a durable receipt.
export class ThreadMail {
  constructor(adapter) {
    this.adapter = adapter;
  }
  authorize(actor, action, envelope) {
    if (this.adapter.authorized(actor, action, envelope) !== true) fail('Not authorized.', 403);
  }
  validate(envelope) {
    for (const [name, ref] of [
      ['sender', envelope.sender],
      ['recipient', envelope.recipient]
    ]) {
      const thread = this.adapter.thread(ref.threadId);
      if (!thread || thread.projectId !== envelope.projectId) fail(`${name} project mismatch.`);
      if (thread.version !== ref.version) fail(`Stale ${name} version.`);
    }
    const ref = envelope.selection.source;
    const source = this.adapter.source(envelope.sender.threadId, ref.turnId, ref.revision);
    if (
      !source ||
      source.projectId !== envelope.projectId ||
      source.threadId !== envelope.sender.threadId ||
      source.turnId !== ref.turnId ||
      source.revision !== ref.revision ||
      typeof source.text !== 'string' ||
      ref.end > source.text.length ||
      source.text.slice(ref.start, ref.end) !== envelope.selection.text
    )
      fail('Source selection mismatch.');
  }
  send(actor, input) {
    const envelope = createEnvelope(input),
      hash = digest(envelope);
    return this.adapter.transaction(() => {
      const existing = this.adapter.get(envelope.operationId);
      if (existing) {
        this.authorize(actor, 'send', existing.envelope);
        const stored = this.load(envelope.operationId, existing);
        if (stored.digest !== hash || JSON.stringify(stored.envelope) !== JSON.stringify(envelope))
          fail('Operation identity already used.');
        return freeze(structuredClone(stored));
      }
      this.authorize(actor, 'send', envelope);
      this.validate(envelope);
      const row = {
        envelope,
        digest: hash,
        state: 'pending',
        attemptId: null,
        receipt: null,
        resolution: null
      };
      this.adapter.insert(envelope.operationId, row);
      return freeze(structuredClone(row));
    });
  }
  read(actor, id) {
    return this.adapter.transaction(() => {
      const row = this.load(id);
      this.authorize(actor, 'read', row.envelope);
      return freeze(structuredClone(row));
    });
  }
  load(id, existing) {
    text(id, 128);
    const row = existing ?? this.adapter.get(id);
    if (
      !row ||
      row.envelope?.operationId !== id ||
      digest(createEnvelope(row.envelope)) !== row.digest
    )
      fail('Missing or corrupt mail.');
    return row;
  }
  change(actor, id, action, fn, preEffect = false) {
    return this.adapter.transaction(() => {
      const row = this.load(id);
      this.authorize(actor, action, row.envelope);
      // Only preparation for a new effect requires the original versions to remain current.
      if (preEffect) this.validate(row.envelope);
      fn(row);
      this.adapter.replace(id, row);
      return freeze(structuredClone(row));
    });
  }
  begin(actor, id, attemptId) {
    text(attemptId, 128);
    return this.change(
      actor,
      id,
      'deliver',
      (row) => {
        if (row.state !== 'pending') fail('Delivery is uncertain or already complete.');
        row.state = 'uncertain';
        row.attemptId = attemptId;
      },
      true
    );
  }
  deliver(actor, id, attemptId, receipt) {
    text(attemptId, 128);
    text(receipt, 1600);
    return this.change(actor, id, 'deliver', (row) => {
      if (
        ['delivered', 'acknowledged', 'resolved'].includes(row.state) &&
        row.attemptId === attemptId &&
        row.receipt === receipt
      )
        return;
      if (row.state !== 'uncertain' || row.attemptId !== attemptId)
        fail('Delivery attempt mismatch.');
      if (this.adapter.confirmReceipt(row.envelope, attemptId, receipt, row.digest) !== true)
        fail('Delivery receipt is not verified.');
      row.receipt = receipt;
      row.state = 'delivered';
    });
  }
  acknowledge(actor, id) {
    return this.change(actor, id, 'acknowledge', (row) => {
      if (['acknowledged', 'resolved'].includes(row.state)) return;
      if (row.state !== 'delivered') fail('Delivery receipt required.');
      row.state = 'acknowledged';
    });
  }
  resolve(actor, id, resolution) {
    text(resolution);
    return this.change(actor, id, 'resolve', (row) => {
      if (row.state === 'resolved' && row.resolution === resolution) return;
      if (row.state !== 'acknowledged') fail('Acknowledgement required.');
      row.resolution = resolution;
      row.state = 'resolved';
    });
  }
}
