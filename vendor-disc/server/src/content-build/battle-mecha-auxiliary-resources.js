import crypto from 'node:crypto';

import {
  CONTENT_FAMILY_SCHEMAS,
  validateCleanContentValue,
  validateContentAssetRecord,
} from '../../../shared/content/content-schema.js';
import { XenoFormatError } from '../xeno/binary-reader.js';
import {
  decodeBattleMechaKeyframes,
  decodeBattleMechaProgram,
  decodeBattleMechaSequence,
  parseBattleMechaPackedUploads,
  parseBattleMechaRelocatedTable,
} from './battle-mecha-resources.js';
import { decodeBattleMechaAuxiliarySprites } from './battle-mecha-auxiliary-sprites.js';
import { assertSourceContext, verifyDecoderDidNotMutate } from './source-input.js';

export const BATTLE_MECHA_AUXILIARY_DECODER = Object.freeze({ id: 'battle-mecha-auxiliary-resources', revision: 7 });
export const BATTLE_MECHA_AUXILIARY_COUNT = 231;
const FIRST_FLAT_INDEX = Object.freeze({ 1: 3149, 2: 3144 });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function battleMechaAuxiliaryAssetId(discNumber, memberNumber) {
  if (![1, 2].includes(discNumber) || !Number.isSafeInteger(memberNumber) || memberNumber < 1 || memberNumber > BATTLE_MECHA_AUXILIARY_COUNT) {
    throw new RangeError('Battle auxiliary resource requires a retail disc and catalog member number.');
  }
  return `xg:d${discNumber}:asset:battle:mecha-auxiliary-${String(memberNumber).padStart(3, '0')}`;
}

function fail(message, details = {}) {
  throw new XenoFormatError(message, 'INVALID_BATTLE_MECHA_AUXILIARY_RESOURCE', details);
}

function tableRecord(table) {
  return {
    sourceRange: table.sourceRange,
    headerRange: table.headerRange,
    offsets: table.offsets,
    entries: table.entries,
  };
}

/** Build-only decoding of the parameter-selected archive loaded by Battle opcode 4. */
export function decodeBattleMechaAuxiliaryResource(value, context, contract, polygonShatterContract = null, textureContext = null) {
  assertSourceContext(value, context);
  if (textureContext && textureContext.sourceSha256 !== context.sha256) throw new Error('Inherited texture context belongs to another source resource.');
  if (
    contract?.schema?.name !== 'xenogears-battle-mecha-auxiliary-contract'
    || contract.schema.version !== 1 || contract.complete !== true
    || contract.discNumber !== context.discNumber
    || contract.source?.expandedSha256 !== '1830b4ef1fe37129972fc310dfad534f8161d6c0b123e74254c3711334a3e291'
  ) throw new TypeError('Battle auxiliary decoder requires the authenticated retail playback contract.');
  if (polygonShatterContract !== null && polygonShatterContract.discNumber !== context.discNumber) {
    throw new TypeError('Battle auxiliary polygon shatter contract must belong to the same disc.');
  }
  if (
    context.directoryOrdinal !== 21 || context.fileIndex >= BATTLE_MECHA_AUXILIARY_COUNT
    || context.flatIndex !== FIRST_FLAT_INDEX[context.discNumber] + context.fileIndex
    || context.storageLayout !== 'ordinary'
  ) throw new TypeError('Battle auxiliary decoder requires its exact archive source context.');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const root = parseBattleMechaRelocatedTable(bytes, 0, bytes.length, 'Battle auxiliary root', 2);
  const nested = (entry, label, count = null) => {
    if (!entry.present) fail(`${label} is absent.`);
    return parseBattleMechaRelocatedTable(bytes, entry.sourceRange.offset, entry.sourceRange.offset + entry.sourceRange.length, label, count);
  };
  const animationTable = nested(root.entries[0], 'Battle auxiliary animation table');
  if (animationTable.count === 0) fail('Battle auxiliary animation table has no keyframe member.');
  const keyframeTable = nested(animationTable.entries[0], 'Battle auxiliary keyframe table');
  const auxiliaryTable = nested(root.entries[1], 'Battle auxiliary effect table', 6);
  if (auxiliaryTable.entries.some(entry => entry.present && ![0, 1, 4].includes(entry.index))) {
    fail('Battle auxiliary archive contains an unproven effect member.');
  }
  const keyframes = decodeBattleMechaKeyframes(bytes, keyframeTable);
  const scriptsPresent = animationTable.entries.slice(1).some(entry => entry.present);
  const storedProgram = scriptsPresent ? decodeBattleMechaProgram(bytes, animationTable) : null;
  const textureEntry = auxiliaryTable.entries[4];
  const textureUploads = textureEntry.present
    ? parseBattleMechaPackedUploads(bytes, textureEntry.sourceRange.offset, textureEntry.sourceRange.offset + textureEntry.sourceRange.length, 'Battle auxiliary textures')
    : null;
  const spriteEntry = auxiliaryTable.entries[0];
  const sprites = spriteEntry.present
    ? decodeBattleMechaAuxiliarySprites(bytes.subarray(spriteEntry.sourceRange.offset, spriteEntry.sourceRange.offset + spriteEntry.sourceRange.length), {
      sourceOffset: spriteEntry.sourceRange.offset,
      textureUploads: textureUploads?.uploads ?? [],
      polygonShatterContract,
      initialTextureUploads: textureContext?.uploads ?? [],
    })
    : null;
  const sequenceEntry = auxiliaryTable.entries[1];
  const soundEffects = sequenceEntry.present ? decodeBattleMechaSequence(bytes, context, sequenceEntry) : null;
  const diagnostics = (sprites?.diagnostics ?? []).map(diagnostic => ({ severity: 'error', ...diagnostic }));
  const complete = diagnostics.length === 0;
  const resource = {
    memberIndex: context.fileIndex,
    nativeFileNumber: context.fileIndex + 2,
    playback: Object.fromEntries(['loader', 'finalizer', 'keyframes', 'skeleton'].map(key => {
      const { evidence, ...behavior } = contract[key];
      return [key, behavior];
    })),
    container: {
      root: tableRecord(root),
      animation: tableRecord(animationTable),
      keyframes: tableRecord(keyframeTable),
      effects: tableRecord(auxiliaryTable),
    },
    fps: 30,
    keyframes,
    storedProgram: storedProgram === null ? null : {
      runtimeUse: 'not-entered-by-auxiliary-loader',
      ...storedProgram,
    },
    textureUploads,
    ...(textureContext ? { inheritedTextureContext: textureContext } : {}),
    sprites,
    soundEffects,
    runtimeRequirements: [
      'battle-mecha-auxiliary-loader',
      'battle-owner-skeleton-and-pose',
      'battle-entity-state',
      'battle-camera-and-terrain',
      'battle-effects',
      'battle-audio-sample-bank',
      ...(sprites?.program.polygonShatter ? ['battle-loaded-polygon-shatter-module'] : []),
    ],
  };
  const semantic = validateCleanContentValue({
    schema: { name: 'xenogears-battle-mecha-auxiliary-resource', version: 1 },
    complete,
    decoder: { ...BATTLE_MECHA_AUXILIARY_DECODER },
    sourceId: context.sourceId,
    resource,
    diagnostics,
  }, 'Battle auxiliary resource');
  const assetId = battleMechaAuxiliaryAssetId(context.discNumber, resource.memberIndex + 1);
  const assets = [];
  if (complete) {
    const asset = {
      schema: { name: CONTENT_FAMILY_SCHEMAS.battle.name, version: CONTENT_FAMILY_SCHEMAS.battle.version },
      id: assetId,
      family: 'battle',
      kind: 'mecha-auxiliary-resource',
      dependencies: [],
      provenance: {
        decoder: { ...BATTLE_MECHA_AUXILIARY_DECODER },
        sources: [
          { id: context.sourceId, role: 'mecha-auxiliary-resource', sha256: context.sha256, bytes: bytes.length, ranges: [{ offset: 0, length: bytes.length }] },
          { id: contract.source.id, role: 'battle-animation-consumer', sha256: contract.source.sha256, bytes: contract.source.bytes, ranges: [{ offset: 0, length: contract.source.bytes }] },
          { id: contract.evidence.executable.sourceId, role: 'archive-and-image-consumer', sha256: contract.evidence.executable.sha256, bytes: contract.evidence.executable.bytes, ranges: [{ offset: 0, length: contract.evidence.executable.bytes }] },
          ...(sprites?.program.polygonShatter ? [{
            ...polygonShatterContract.sources.overlay, role: 'polygon-shatter-consumer',
            ranges: [{ offset: 0, length: polygonShatterContract.sources.overlay.bytes }],
          }] : []),
        ],
      },
      coordinates: [],
      timing: [],
      artifacts: [],
      diagnostics: [],
      data: { gears: [resource] },
    };
    validateContentAssetRecord(asset);
    assets.push(asset);
  }
  verifyDecoderDidNotMutate(bytes, context);
  const { memberIndex, nativeFileNumber, ...content } = resource;
  return { semantic, assets, outputSha256: sha256(JSON.stringify(resource)), coreSha256: sha256(JSON.stringify(content)) };
}
