import { createHash } from 'node:crypto';
import {
  NativeStore,
  nativeFileId,
  validateNativeId,
  validateNativeLabel,
  validateNativePath
} from './native-store.mjs';

export const maxChatAttachments = 4;
export const maxChatAttachmentBytes = 8192;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function requireValue(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
function fields(value, keys) {
  requireValue(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    'Unexpected chat attachment fields.'
  );
}
function checkSize(size) {
  requireValue(
    size <= maxChatAttachmentBytes,
    'Chat attachments may contain at most 8,192 bytes in total.'
  );
}
function bytesOf(base64) {
  requireValue(
    typeof base64 === 'string' && base64.length <= 4 * Math.ceil(maxChatAttachmentBytes / 3),
    'Supply canonical base64 within the chat attachment limit.'
  );
  const bytes = Buffer.from(base64, 'base64');
  requireValue(
    bytes.toString('base64') === base64,
    'Supply canonical base64 for the selected file.'
  );
  checkSize(bytes.length);
  return bytes;
}
function asText(bytes) {
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    /* Invalid input is reported below. */
  }
  requireValue(
    typeof text === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text),
    'Chat attachments must be UTF-8 text files without binary control characters.'
  );
  return text;
}

export function normalizeChatAttachments(input) {
  requireValue(
    Array.isArray(input) && input.length <= maxChatAttachments,
    'Attach up to four text files.'
  );
  let total = 0;
  return input.map((value) => {
    if (value?.kind === 'local') {
      fields(value, ['kind', 'filename', 'base64']);
      const { kind, filename, base64 } = value;
      requireValue(
        typeof filename === 'string' &&
          filename.isWellFormed() &&
          filename.trim() &&
          Buffer.byteLength(filename) <= 255 &&
          filename !== '.' &&
          filename !== '..' &&
          !/[/\\\u0000-\u001f\u007f]/u.test(filename),
        'Supply a local filename without directories or control characters.'
      );
      const bytes = bytesOf(base64);
      checkSize((total += bytes.length));
      asText(bytes);
      return { kind, filename, base64 };
    }
    fields(value, ['kind', 'repository', 'name', 'revisionId', 'path', 'fileId']);
    const { kind, repository, name, revisionId, path, fileId } = value;
    requireValue(
      kind === 'native' &&
        typeof name === 'string' &&
        /^[a-z][a-z0-9-]{0,47}$/u.test(name) &&
        !['main', 'integration', 'release'].includes(name),
      'Select a native mainline or owner draft file.'
    );
    return {
      kind,
      repository: validateNativeLabel(repository),
      name,
      revisionId: validateNativeId(revisionId),
      path: validateNativePath(path),
      fileId: validateNativeId(fileId)
    };
  });
}

function fileFacts(bytes) {
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function checkNative(ref, file) {
  requireValue(
    file &&
      file.repository === ref.repository &&
      file.revisionId === ref.revisionId &&
      file.path === ref.path &&
      file.fileId === ref.fileId,
    'The selected native file does not match its exact revision, path and content.',
    409
  );
  requireValue(
    file.mode === '100644' || file.mode === '100755',
    'Attach a regular native text file.'
  );
}
export function captureChatAttachments(inputs, readAttachment) {
  let total = 0;
  return inputs.map((ref) => {
    let bytes;
    if (ref.kind === 'local') bytes = bytesOf(ref.base64);
    else {
      requireValue(
        typeof readAttachment === 'function',
        'Native attachment selection is unavailable.',
        409
      );
      const file = readAttachment(ref);
      checkNative(ref, file);
      requireValue(
        file.name === ref.name,
        'The selected file does not belong to the requested draft or mainline.',
        409
      );
      checkSize(file.total);
      requireValue(
        file.offset === 0 && file.nextOffset === null,
        'The selected native file is incomplete.',
        409
      );
      bytes = bytesOf(file.base64);
      requireValue(
        file.total === bytes.length && nativeFileId(bytes) === ref.fileId,
        'The selected native file failed its content check.',
        409
      );
    }
    checkSize((total += bytes.length));
    asText(bytes);
    return { ...ref, ...fileFacts(bytes) };
  });
}
export function attachmentMetadata(record) {
  const { base64, ...metadata } = record;
  return metadata;
}
export function attachmentInputs(records) {
  return normalizeChatAttachments(records.map(({ size, sha256, ...ref }) => ref));
}
export function restoreChatAttachments(db, records) {
  let total = 0;
  const native = new NativeStore({ db });
  return attachmentInputs(records).map((ref, index) => {
    let bytes;
    if (ref.kind === 'local') bytes = bytesOf(ref.base64);
    else {
      // Selection was authorized on send. Resolve that immutable revision even
      // if the selected draft now points elsewhere.
      const file = native.file(ref);
      checkNative(ref, file);
      bytes = file.bytes;
    }
    checkSize((total += bytes.length));
    const { size, sha256 } = fileFacts(bytes),
      record = records[index];
    requireValue(
      record.size === size && record.sha256 === sha256,
      'The retained chat attachment failed its content check.',
      409
    );
    return { attachment: attachmentMetadata(record), text: asText(bytes) };
  });
}
