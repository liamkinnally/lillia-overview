import { createEnvelope } from './thread-mail.mjs';

export function mailError(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
function fields(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== names.sort().join(',')
  )
    mailError('Invalid owner mail input.', 400);
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    mailError('Invalid mail identity.', 400);
  return value;
}
export function normalizeOwnerMailSend(input) {
  fields(input, ['projectId', 'sender', 'recipient', 'selection', 'mode']);
  if (!['start-reply', 'queue-next-reply'].includes(input.mode))
    mailError('Invalid incoming mail mode.', 400);
  const { operationId, ...envelope } = createEnvelope({
    operationId: 'owner-intent',
    projectId: input.projectId,
    sender: input.sender,
    recipient: input.recipient,
    selection: input.selection
  });
  return { ...envelope, mode: input.mode };
}
export function normalizeOwnerMailAction(input, name) {
  fields(input, [
    'projectId',
    'id',
    'digest',
    'attemptId',
    'receipt',
    'expectedState',
    ...(name === 'chat.mail.resolve' ? ['resolution'] : [])
  ]);
  if (
    typeof input.projectId !== 'string' ||
    typeof input.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.digest) ||
    typeof input.receipt !== 'string' ||
    !input.receipt.trim() ||
    input.receipt.length > 1600 ||
    input.expectedState !== (name === 'chat.mail.resolve' ? 'acknowledged' : 'delivered') ||
    (name === 'chat.mail.resolve' &&
      (typeof input.resolution !== 'string' ||
        !input.resolution.trim() ||
        input.resolution.length > 1600))
  )
    mailError('Invalid owner mail action proof.', 400);
  return {
    projectId: input.projectId,
    id: id(input.id),
    digest: input.digest,
    attemptId: id(input.attemptId),
    receipt: input.receipt,
    expectedState: input.expectedState,
    ...(name === 'chat.mail.resolve' ? { resolution: input.resolution } : {})
  };
}
export function normalizeOwnerMailRead(input) {
  fields(input, ['projectId', 'id']);
  return { projectId: id(input.projectId), id: id(input.id) };
}
export function normalizeOwnerMailList(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !['projectId', 'threadId', 'after', 'limit'].includes(k))
  )
    mailError('Invalid mail list.', 400);
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    mailError('Invalid mail list limit.', 400);
  return {
    projectId: id(input.projectId),
    threadId: id(input.threadId),
    ...(input.after !== undefined ? { after: id(input.after) } : {}),
    limit
  };
}

// Created only by the private owner ingress, never decoded from renderer input.
const actor = Object.freeze({ kind: 'local-owner', uid: process.getuid() });
export function localMailOwner() {
  return actor;
}
export function assertMailOwner(value) {
  if (value !== actor) mailError('Local owner mail ingress required.', 403);
}
