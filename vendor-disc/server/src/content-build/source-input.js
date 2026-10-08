import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readSourceWorkspaceIndex } from '../xeno/source-workspace.js';

const SOURCE_ID_PATTERN = /^xg:d([12]):file-([0-9]{6})$/;
const SOURCE_STORAGE_LAYOUTS = new Set(['empty', 'mode2-stream', 'ordinary']);
const SOURCE_CONTEXT_FIELDS = [
  'sourceId',
  'discNumber',
  'directoryOrdinal',
  'fileIndex',
  'flatIndex',
  'logicalBytes',
  'sha256',
  'storageLayout',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertDiscNumber(discNumber) {
  if (discNumber !== 1 && discNumber !== 2) {
    throw new RangeError('Disc number must be 1 or 2.');
  }
}

export function assertSourceContext(bytes, context) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Decoder input must be a Uint8Array.');
  const idMatch = typeof context?.sourceId === 'string'
    ? SOURCE_ID_PATTERN.exec(context.sourceId)
    : null;
  if (
    idMatch === null
    || SOURCE_CONTEXT_FIELDS.some((field) => !Object.hasOwn(context, field))
    || !Number.isSafeInteger(context.discNumber)
    || context.discNumber !== Number(idMatch[1])
    || !Number.isSafeInteger(context.directoryOrdinal)
    || context.directoryOrdinal < 0
    || !Number.isSafeInteger(context.fileIndex)
    || context.fileIndex < 0
    || !Number.isSafeInteger(context.flatIndex)
    || context.flatIndex < 0
    || context.flatIndex !== Number(idMatch[2])
    || !Number.isSafeInteger(context.logicalBytes)
    || context.logicalBytes < 0
    || context.logicalBytes !== bytes.byteLength
    || typeof context.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(context.sha256)
    || typeof context.storageLayout !== 'string'
    || !SOURCE_STORAGE_LAYOUTS.has(context.storageLayout)
    || sha256(bytes) !== context.sha256
  ) {
    throw new TypeError('Decoder requires matching source bytes and context.');
  }
}

function resolveOwnedFile(rootDir, workspacePath) {
  if (
    typeof workspacePath !== 'string'
    || workspacePath.includes('\\')
    || workspacePath.startsWith('/')
    || workspacePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Source occurrence has an invalid workspace path.');
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...workspacePath.split('/'));
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Source occurrence path escapes its workspace.');
  }
  return target;
}

export function sourcePayloadPath(sourceInputs, sourceId) {
  const record = sourceInputs?.records?.get(sourceId);
  if (!record) throw new RangeError(`Unknown source occurrence: ${sourceId}.`);
  if (record.recordType !== 'file' || record.workspacePath === null) {
    throw new TypeError(`Source occurrence ${sourceId} has no materialized payload.`);
  }
  return resolveOwnedFile(sourceInputs.rootDir, record.workspacePath);
}

export function openSourceInputs(sourceRootDir, discNumber) {
  assertDiscNumber(discNumber);
  const rootDir = path.resolve(sourceRootDir, `disc-${discNumber}`);
  const index = readSourceWorkspaceIndex(rootDir);
  if (index.source.discNumber !== discNumber) {
    throw new Error(`Disc ${discNumber} source workspace contains the wrong source index.`);
  }
  const records = new Map(index.files.map((record) => [record.id, record]));
  if (records.size !== index.files.length) {
    throw new Error(`Disc ${discNumber} source workspace contains duplicate occurrence IDs.`);
  }
  return Object.freeze({ rootDir, index, records });
}

export function sourceLoadContext(sourceInputs, sourceId) {
  const record = sourceInputs?.records?.get(sourceId);
  if (!record) throw new RangeError(`Unknown source occurrence: ${sourceId}.`);
  return Object.freeze({
    discNumber: sourceInputs.index.source.discNumber,
    sourceId: record.id,
    directoryOrdinal: record.directoryOrdinal,
    fileIndex: record.fileIndex,
    flatIndex: record.flatIndex,
    logicalBytes: record.logicalBytes,
    sha256: record.payloadSha256,
    storageLayout: record.storageLayout,
  });
}

export function readSourceBytes(sourceInputs, sourceId) {
  const record = sourceInputs?.records?.get(sourceId);
  if (!record) throw new RangeError(`Unknown source occurrence: ${sourceId}.`);
  const filePath = sourcePayloadPath(sourceInputs, sourceId);
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== record.logicalBytes) {
    throw new Error(`Source occurrence ${sourceId} does not match its indexed file.`);
  }
  const bytes = fs.readFileSync(filePath);
  if (sha256(bytes) !== record.payloadSha256) {
    throw new Error(`Source occurrence ${sourceId} does not match its indexed hash.`);
  }
  return bytes;
}

export function readSourcePrefix(sourceInputs, sourceId, length) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('Source prefix length must be a non-negative integer.');
  }
  const record = sourceInputs?.records?.get(sourceId);
  if (!record) throw new RangeError(`Unknown source occurrence: ${sourceId}.`);
  const filePath = sourcePayloadPath(sourceInputs, sourceId);
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== record.logicalBytes) {
    throw new Error(`Source occurrence ${sourceId} does not match its indexed file.`);
  }
  const result = Buffer.alloc(Math.min(length, record.logicalBytes));
  if (result.length === 0) return result;
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(descriptor, result, 0, result.length, 0);
    if (bytesRead !== result.length) throw new Error(`Source occurrence ${sourceId} is truncated.`);
  } finally {
    fs.closeSync(descriptor);
  }
  return result;
}

export function verifyDecoderDidNotMutate(bytes, context) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Decoder input must be a Uint8Array.');
  if (bytes.byteLength !== context.logicalBytes || sha256(bytes) !== context.sha256) {
    throw new Error(`Decoder mutated source occurrence ${context.sourceId}.`);
  }
}
