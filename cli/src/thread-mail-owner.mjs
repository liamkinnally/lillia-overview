import { createHash } from 'node:crypto';
import { ThreadMail, createEnvelope } from './thread-mail.mjs';
import { ThreadMailSqliteStore } from './thread-mail-store.mjs';
import { readThreadMailThread, readThreadMailSource } from './thread-mail-source.mjs';
import { readBranchThread } from './project-chat-branch-threads.mjs';
import { readChatBranch, inspectParentGrant, verifyParentGrant } from './project-chat-branches.mjs';
import { chatProject, readChatOrigin } from './project-chat-origins.mjs';
import { readChatContext } from './project-chat-contexts.mjs';
import { verifyMailReceipt, confirmedMailReceipt } from './thread-mail-effects.mjs';
import {
  assertMailOwner,
  mailError,
  normalizeOwnerMailSend,
  normalizeOwnerMailAction,
  normalizeOwnerMailRead,
  normalizeOwnerMailList
} from './thread-mail-owner-input.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class OwnerThreadMail {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.storage = new ThreadMailSqliteStore(this.db);
    const self = this;
    this.core = new ThreadMail({
      transaction: (fn) => self.storage.transaction(fn),
      get: (id) => self.storage.get(id),
      insert: (id, row) => self.storage.insert(id, row),
      replace: (id, row) => self.storage.replace(id, row),
      thread: (id) => readThreadMailThread(self.db, chatProject(self.db).projectId, id),
      source: (threadId, turnId, revision) =>
        readThreadMailSource(self.db, {
          projectId: chatProject(self.db).projectId,
          threadId,
          turnId,
          revision
        }),
      authorized: (actor, action, envelope) => self.authorized(actor, action, envelope),
      confirmReceipt: (...args) => self.confirmReceipt(...args)
    });
  }
  normalize(name, input) {
    return name === 'chat.mail.send'
      ? normalizeOwnerMailSend(input)
      : normalizeOwnerMailAction(input, name);
  }
  confirmReceipt(envelope, attemptId, receipt, digest) {
    return verifyMailReceipt(this.db, envelope, attemptId, receipt, digest);
  }
  relationship(envelope, current) {
    const { sender, recipient, projectId } = envelope;
    if (
      chatProject(this.db).projectId !== projectId ||
      sender.threadId === recipient.threadId ||
      (sender.threadId !== 'root' && recipient.threadId !== 'root')
    )
      mailError('Mail requires a same-project root/direct-child relationship.', 403);
    const child = sender.threadId === 'root' ? recipient.threadId : sender.threadId;
    const { branchThread } = readBranchThread(this.db, child);
    const { branch } = readChatBranch(this.db, { projectId, id: branchThread.preparationId });
    if (
      branch.parentThreadId !== 'root' ||
      branch.kind !== 'branch' ||
      branchThread.projectId !== projectId
    )
      mailError('Mail direct-child proof differs.', 403);
    const grants = [];
    let id = branchThread.parentGrantId;
    while (id) {
      if (grants.includes(id) || grants.length >= 32) mailError('Mail ancestor grant differs.');
      const grant = inspectParentGrant(this.db, { projectId, id });
      if (current) {
        try {
          verifyParentGrant(this.db, {
            projectId,
            id,
            selectionId: grant.selectionId,
            accountInstance: branch.recipient.accountInstance
          });
        } catch {
          mailError('Mail current parent grant or account unavailable.', 403);
        }
      }
      grants.push(id);
      id = grant.parentGrantId;
    }
    const binding = this.db
      .prepare("SELECT value FROM settings WHERE key='codex.accountBinding'")
      .get()?.value;
    if (current && !binding) mailError('Mail account binding unavailable.', 403);
    return {
      branchThreadId: child,
      branchOperationId: this.db
        .prepare('SELECT operationId FROM project_chat_branch_threads WHERE threadId=?')
        .get(child).operationId,
      parentGrantId: branchThread.parentGrantId,
      grantIds: grants,
      accountInstance: branch.recipient.accountInstance,
      accountBinding: binding ?? null
    };
  }
  selection(envelope) {
    const ref = envelope.selection.source;
    const { context } = readChatContext(this.db, {
      projectId: envelope.projectId,
      id: ref.revision
    });
    const { text, ...metadata } = context;
    const pin = this.db
      .prepare('SELECT operationId FROM project_chat_context_pins WHERE id=?')
      .get(ref.revision);
    const receipt = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(pin.operationId);
    const origin = readChatOrigin(this.db, {
      projectId: envelope.projectId,
      id: context.originId
    }).origin;
    const originOp = this.db
      .prepare('SELECT operationId FROM project_chat_origins WHERE id=?')
      .get(origin.id).operationId;
    const originReceipt = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(originOp);
    if (
      !receipt ||
      receipt.digest !==
        hash(['chat.context.pin', { projectId: envelope.projectId, originId: context.originId }]) ||
      !equal(JSON.parse(receipt.receipt), { operationId: pin.operationId, context: metadata }) ||
      !originReceipt ||
      originReceipt.digest !==
        hash([
          'chat.origin.create',
          {
            projectId: origin.projectId,
            threadId: origin.threadId,
            turnId: origin.turnId,
            role: origin.role
          }
        ]) ||
      !equal(JSON.parse(originReceipt.receipt), { operationId: originOp, origin }) ||
      context.threadId !== envelope.sender.threadId ||
      String(context.turnId) !== ref.turnId ||
      ref.end > text.length ||
      text.slice(ref.start, ref.end) !== envelope.selection.text
    )
      mailError('Mail immutable selection proof differs.');
  }
  authorization(envelope) {
    const row = this.db
      .prepare('SELECT record FROM thread_mail_owner_authorizations WHERE operationId=?')
      .get(envelope.operationId);
    if (!row) mailError('Mail exact owner authorization unavailable.');
    let record;
    try {
      record = JSON.parse(row.record);
    } catch {
      mailError('Mail owner authorization corrupt.');
    }
    let normalized;
    try {
      normalized = normalizeOwnerMailSend(record.input);
    } catch {
      mailError('Mail retained input differs.');
    }
    if (
      record.envelopeDigest !== hash(createEnvelope(envelope)) ||
      !equal(record.input, normalized) ||
      !equal(
        createEnvelope({ operationId: envelope.operationId, ...normalizedEnvelope(normalized) }),
        envelope
      ) ||
      record.owner?.kind !== 'local-owner' ||
      !Number.isSafeInteger(record.owner.uid) ||
      record.owner.uid < 0 ||
      record.mode !== normalized.mode ||
      !record.relationship ||
      typeof record.relationship !== 'object' ||
      !Array.isArray(record.relationship.grantIds)
    )
      mailError('Mail exact owner authorization differs.');
    if (this.admitting !== envelope.operationId) {
      const action = this.checkedAction(envelope.operationId);
      if (
        action.name !== 'chat.mail.send' ||
        !equal(action.input, record.input) ||
        !equal(action.result.authorization, record) ||
        action.result.mail.digest !== record.envelopeDigest ||
        action.result.mode !== record.mode ||
        action.result.mail.state !== 'pending' ||
        action.result.mail.attemptId !== null ||
        action.result.mail.receipt !== null ||
        !equal(action.result.mail.envelope, envelope)
      )
        mailError('Mail owner receipt differs.');
    }
    const relation = this.relationship(envelope, false);
    const { accountBinding, ...saved } = record.relationship;
    const { accountBinding: ignored, ...historical } = relation;
    if (!equal(saved, historical) || typeof accountBinding !== 'string' || !accountBinding)
      mailError('Mail retained relationship differs.');
    this.selection(envelope);
    return record;
  }
  authorized(actor, action, envelope) {
    assertMailOwner(actor);
    const record = this.authorization(envelope);
    if (record.owner.uid !== actor.uid) return false;
    if (action === 'read') return true;
    const row = this.storage.get(envelope.operationId);
    if (action === 'deliver' && row?.state === 'uncertain')
      return !!confirmedMailReceipt(this.db, envelope, row.attemptId, row.digest);
    try {
      const current = this.relationship(envelope, true);
      if (!equal(current, record.relationship)) return false;
      for (const ref of [envelope.sender, envelope.recipient]) {
        readThreadMailThread(this.db, envelope.projectId, ref.threadId);
        const denied = this.db
          .prepare('SELECT enabled FROM thread_mail_permissions WHERE threadId=?')
          .get(ref.threadId);
        if (denied?.enabled === 0) return false;
      }
    } catch {
      return false;
    }
    if (action === 'acknowledge' || action === 'resolve' || action === 'deliver') {
      if (action === 'deliver' && row?.state === 'pending') return true;
      return (
        !!row && this.confirmReceipt(envelope, row.attemptId, row.receipt, row.digest) === true
      );
    }
    return action === 'send';
  }
  checkedAction(id) {
    const row = this.db
      .prepare('SELECT * FROM thread_mail_owner_actions WHERE operationId=?')
      .get(id);
    const saved = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(id);
    if (!row || !saved) mailError('Mail action receipt unavailable.');
    try {
      const input = this.normalize(row.name, JSON.parse(row.input)),
        result = JSON.parse(row.result);
      if (
        saved.digest !== hash([row.name, input]) ||
        !equal(result, JSON.parse(saved.receipt)) ||
        result.operationId !== id
      )
        mailError('Mail action receipt differs.');
      return { name: row.name, input, result };
    } catch {
      mailError('Mail action receipt differs.');
    }
  }
  projection(row, authorization) {
    if (
      ['delivered', 'acknowledged', 'resolved'].includes(row.state) &&
      !this.confirmReceipt(row.envelope, row.attemptId, row.receipt, row.digest)
    )
      mailError('Mail delivery has no verified native proof.');
    return { mail: row, mode: authorization.mode, authorization };
  }
  replay(name, input, operationId, actor) {
    assertMailOwner(actor);
    const prior = this.db
      .prepare('SELECT 1 FROM command_receipts WHERE operationId=?')
      .get(operationId);
    if (!prior) return null;
    const action = this.checkedAction(operationId);
    if (action.name !== name || !equal(action.input, input))
      mailError('Mail operation identity already used.');
    const id = name === 'chat.mail.send' ? operationId : input.id;
    const row = this.storage.get(id);
    if (!row) mailError('Mail receipt has no envelope.');
    this.core.authorize(
      actor,
      name === 'chat.mail.send' ? 'send' : name.split('.').at(-1),
      row.envelope
    );
    return { operationId, ...this.projection(row, this.authorization(row.envelope)) };
  }
  command(
    name,
    input,
    operationId,
    actor,
    apply = () => this.apply(name, input, operationId, actor)
  ) {
    assertMailOwner(actor);
    input = this.normalize(name, input);
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId))
      mailError('Stable mail action identity required.', 400);
    const previous = this.replay(name, input, operationId, actor);
    if (previous) return previous;
    return this.store.accept(operationId, hash([name, input]), apply);
  }
  apply(name, input, operationId, actor) {
    assertMailOwner(actor);
    if (!this.db.isTransaction) mailError('Mail action requires the owner transaction.');
    let row, record;
    if (name === 'chat.mail.send') {
      if (this.storage.get(operationId))
        mailError('Unowned retained mail cannot acquire new authority.');
      // The shown owner preview selected this mode. Settings choose later previews,
      // and cannot reinterpret this exact normalized operation during acceptance/retry.
      const mode = input.mode;
      const envelope = createEnvelope({ operationId, ...normalizedEnvelope(input) });
      record = {
        owner: { kind: actor.kind, uid: actor.uid },
        mode,
        input,
        envelopeDigest: hash(envelope),
        relationship: this.relationship(envelope, true)
      };
      this.selection(envelope);
      this.db
        .prepare('INSERT INTO thread_mail_owner_authorizations VALUES(?,?)')
        .run(operationId, JSON.stringify(record));
      this.admitting = operationId;
      try {
        row = this.core.send(actor, envelope);
      } finally {
        this.admitting = null;
      }
    } else {
      row = this.storage.get(input.id);
      if (
        !row ||
        row.envelope.projectId !== input.projectId ||
        row.digest !== input.digest ||
        row.attemptId !== input.attemptId ||
        row.receipt !== input.receipt ||
        row.state !== input.expectedState ||
        !this.confirmReceipt(row.envelope, row.attemptId, row.receipt, row.digest)
      )
        mailError('Mail action requires exact verified delivery proof.');
      row =
        name === 'chat.mail.acknowledge'
          ? this.core.acknowledge(actor, input.id)
          : this.core.resolve(actor, input.id, input.resolution);
      record = this.authorization(row.envelope);
    }
    const result = this.projection(row, record);
    this.db
      .prepare('INSERT INTO thread_mail_owner_actions VALUES(?,?,?,?)')
      .run(operationId, name, JSON.stringify(input), JSON.stringify({ operationId, ...result }));
    return result;
  }
  read(actor, input) {
    assertMailOwner(actor);
    input = normalizeOwnerMailRead(input);
    return this.storage.transaction(() => {
      const row = this.core.read(actor, input.id);
      if (row.envelope.projectId !== input.projectId) mailError('Mail project mismatch.', 403);
      return {
        operationId: row.envelope.operationId,
        ...this.projection(row, this.authorization(row.envelope))
      };
    });
  }
  list(actor, input) {
    assertMailOwner(actor);
    input = normalizeOwnerMailList(input);
    readThreadMailThread(this.db, input.projectId, input.threadId);
    return this.storage.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT operationId FROM thread_mail_operations WHERE operationId>?
        AND json_extract(envelope,'$.recipient.threadId')=? ORDER BY operationId LIMIT ?`
        )
        .all(input.after ?? '', input.threadId, input.limit);
      return {
        mail: rows.map((row) =>
          this.read(actor, { projectId: input.projectId, id: row.operationId })
        ),
        next: rows.length === input.limit ? rows.at(-1).operationId : null
      };
    });
  }
}
function normalizedEnvelope(input) {
  const { mode, ...envelope } = input;
  return envelope;
}
