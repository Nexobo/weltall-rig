import crypto from 'node:crypto';
import { PNG } from 'pngjs';

import {
  CONTENT_FAMILY_SCHEMAS,
  validateCleanContentValue,
  validateContentAssetRecord,
} from '../../../shared/content/content-schema.js';
import { parseSceneModelAnimationProgram } from '../../../shared/runtime/scene-model-animation.js';
import { BinaryReader, XenoFormatError } from '../xeno/binary-reader.js';
import { decodeSceneModel } from '../xeno/scene-model.js';
import { decodeSoundSequence } from './audio-decoders.js';
import {
  compileSceneModelAnimationKeyframe,
  compileSceneModelAnimationProgram,
} from './scene-model-program-compiler.js';
import {
  assertSourceContext,
  verifyDecoderDidNotMutate,
} from './source-input.js';

export const BATTLE_MECHA_RESOURCE_DECODER = Object.freeze({
  id: 'battle-mecha-resources',
  revision: 3,
});

export const BATTLE_GEAR_COUNT = 19;

const BATTLE_MECHA_DIRECTORY_ORDINAL = 20;
const BATTLE_MECHA_FIRST_FLAT_INDEX = Object.freeze({ 1: 2926, 2: 2921 });

const RESOURCE_ROWS = [
  [1, 0], [3, 0], [5, 6], [13, 0], [15, 3], [20, 4], [26, 0],
  [28, 0], [30, 0], [32, 0], [34, 0], [36, 4], [42, 3], [47, 4],
  [53, 0], [55, 0], [57, 0], [59, 0], [61, 0],
];

const TEXTURE_ONLY_GEARS = new Set([4, 12]);

export const BATTLE_GEAR_RESOURCE_MAP = Object.freeze(RESOURCE_ROWS.map(([
  modelFileNumber,
  optionalResourceCount,
], gearId) => Object.freeze({
  gearId,
  modelFileNumber,
  animationFileNumber: modelFileNumber + 1,
  optionalResourceCount,
  optionalKind: optionalResourceCount === 0
    ? null
    : TEXTURE_ONLY_GEARS.has(gearId)
      ? 'texture-variant'
      : 'animated-child-model',
  optionalFileNumbers: Object.freeze(Array.from(
    { length: optionalResourceCount },
    (_, index) => modelFileNumber + 2 + index,
  )),
})));

const OPCODE_NAMES = Object.freeze([
  'stop',
  'wait',
  'coordinate-display-state',
  'wait-for-presentation-state',
  'load-auxiliary-animation-resource',
  'finalize-auxiliary-resource',
  'setup-current-gear-animation',
  'reset-animation-display-mode',
  'release-all-bone-tracks',
  'release-tracks-alternate',
  'release-selected-tracks',
  'release-tracks-and-child-motion',
  'clear-pending-motion',
  'release-rotation-tracks',
  'release-translation-tracks',
  'reset-battle-presentation-state',
  'apply-keyframe-pose',
  'bind-keyframe-stream',
  'bind-keyframe-stream-alternate',
  'bind-keyframe-transition',
  'dispatch-entity-mask-command',
  'clone-gear-visual',
  'restore-and-destroy-clone',
  'destroy-cloned-visual',
  'set-animation-distance-from-keyframe',
  'finalize-keyframe-operation',
  'move-vram-rectangle',
  'configure-battle-visual-record',
  'disable-battle-visual-record',
  'bind-bone-relative-transform',
  'set-skeleton-update-mode',
  'switch-gear-context',
  'wait-for-external-status-100',
  'wait-for-external-status-1',
  'counted-status-wait',
  'set-bone-visibility',
  'set-gear-flag',
  'set-attachment-origin',
  'clear-attachment-ownership',
  'rebuild-skeleton-matrices',
  'continue-if-distance-ratio-below',
  'continue-if-distance-ratio-at-least',
  'continue-if-distance-below-step',
  'continue-if-distance-above-step',
  'continue-if-explicit-distance-below',
  'continue-if-explicit-distance-above',
  'arm-distance-branch',
  'wait-for-battle-presentation',
  'clear-writable-script-word',
  'counted-loop',
  'jump',
  'branch-on-battle-mode',
  'branch-on-gear-state',
  'branch-on-random-clock',
  'arm-timed-callback',
  'arm-target-ground-callback',
  'set-at-target-position',
  'interpolate-to-target-position',
  'wait-for-gear-readiness',
  'branch-on-active-entity-mask',
  'fade-indexed-sound-effect',
  'continue-if-current-target-listed',
  'branch-on-entity-class-state',
  'synchronize-battle-presentation',
  'rotate-to-explicit-angles',
  'rotate-by-relative-angles',
  'turn-pitch-yaw-to-target',
  'turn-yaw-to-target',
  'set-pending-rotation',
  'add-pending-rotation',
  'set-pending-rotation-velocity',
  'add-pending-rotation-velocity',
  'set-matrix-update-variant',
  'set-root-translation',
  'set-root-from-battle-entity',
  'set-pending-translation',
  'add-pending-translation',
  'set-pending-translation-velocity',
  'add-pending-translation-velocity',
  'derive-forward-motion-step',
  'set-target-position',
  'set-target-from-battle-entity',
  'configure-target-interpolation',
  'snap-target-to-terrain',
  'set-scaled-distance-step',
  'add-scaled-distance-step',
  'add-raw-distance-step',
  'add-entity-relative-distance',
  'reset-target-interpolation',
  'set-target-from-camera-vector-a',
  'set-target-from-camera-vector-b',
  'dispatch-target-list-callback',
  'branch-if-root-at-target',
  'set-bone-value-52',
  'set-global-gear-scale',
  'set-gear-value-4a',
  'set-target-to-slot-midpoint',
  'branch-on-slot-layout',
  'configure-bone-relative-movement',
  'initialize-secondary-loop',
  'set-gear-state',
  'spawn-battle-motion-a',
  'spawn-battle-motion-b',
  'spawn-angular-battle-motion',
  'initialize-battle-action-geometry',
  'wait-for-battle-action-state',
  'set-battle-action-complete',
  'set-bone-state-06',
  'wait-for-resource-queue',
  'set-gear-state-38',
  'wait-for-entity-state-bit',
  'snapshot-target-mask',
  'branch-if-target-mask-matches',
  'set-battle-global-command',
  'conditional-stop-on-battle-flag',
  'invoke-battle-command',
  'invoke-terminal-battle-helper',
  'branch-if-facing-target',
]);

if (OPCODE_NAMES.length !== 0x76) {
  throw new Error('Battle Gear opcode table must cover opcodes 0x00 through 0x75.');
}

const WORD_COUNTS = new Map([
  ...[
    0x01, 0x04, 0x11, 0x12, 0x14, 0x15, 0x18, 0x22, 0x23, 0x28, 0x29,
    0x2e, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x37, 0x38, 0x39, 0x3b,
    0x3c, 0x3e, 0x54, 0x55, 0x56, 0x5c, 0x5d, 0x5e, 0x5f, 0x61, 0x63,
    0x64, 0x6b, 0x6e, 0x70, 0x71, 0x75,
  ].map((opcode) => [opcode, 2]),
  ...[0x13, 0x36].map((opcode) => [opcode, 3]),
  ...[
    0x2c, 0x2d, 0x40, 0x41, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4b, 0x4c,
    0x4d, 0x4e, 0x50, 0x65, 0x66,
  ].map((opcode) => [opcode, 4]),
  ...[0x25, 0x52, 0x62, 0x67].map((opcode) => [opcode, 5]),
  [0x1a, 7],
  [0x1d, 10],
  [0x1b, 16],
]);

const BATTLE_ONLY_OPCODES = new Set([
  0x02, 0x03, 0x04, 0x05, 0x06, 0x0f, 0x14, 0x1b, 0x1c, 0x2f, 0x33, 0x34,
  0x35, 0x3a, 0x3b, 0x3c, 0x3e, 0x3f, 0x4a, 0x51, 0x53, 0x57, 0x59, 0x5a,
  0x60, 0x61, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6c, 0x6e, 0x6f, 0x70,
  0x71, 0x72, 0x73, 0x74,
]);

const TERMINAL_OPCODES = new Set([0x00, 0x17, 0x74]);
const BRANCH_OPCODES = new Set([
  0x2e, 0x31, 0x33, 0x34, 0x35, 0x37, 0x3b, 0x3e, 0x5c, 0x61,
  0x70, 0x75,
]);

const TIMED_EVENT_NAMES = Object.freeze({
  1: 'spawn-attached-sprite-effect',
  2: 'configure-global-transform-effect',
  3: 'configure-visual-effect-a',
  4: 'configure-visual-effect-b',
  5: 'play-actor-sounds',
  6: 'battle-synchronization-command',
  7: 'set-bone-visibility',
  8: 'dispatch-action-to-targets',
  9: 'configure-visual-record',
});

const TIMED_EVENT_FIXED_LENGTHS = new Map([
  [1, 0x14],
  [5, 0x08],
  [6, 0x04],
  [7, 0x06],
  [8, 0x0a],
]);

const TIMED_EVENT_ENABLED_LENGTHS = new Map([
  [2, 0x12],
  [3, 0x1c],
  [4, 0x1c],
  [9, 0x1c],
]);

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be bytes.`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceRange(offset, length) {
  return { offset, length };
}

function fail(message, code, details = {}) {
  throw new XenoFormatError(message, code, details);
}

function signedWord(value) {
  return (value & 0x8000) === 0 ? value : value - 0x10000;
}

function rangeHash(bytes, offset, length) {
  return {
    sourceRange: sourceRange(offset, length),
    sha256: sha256(bytes.subarray(offset, offset + length)),
  };
}

function parseRelocatedTable(bytes, base, end, label, expectedCount = null) {
  const reader = new BinaryReader(bytes, label);
  reader.check(base, 4);
  const count = reader.u32(base);
  if (count > 4096 || (expectedCount !== null && count !== expectedCount)) {
    fail(`${label} has an invalid member count.`, 'INVALID_BATTLE_MECHA_ARCHIVE_COUNT', {
      count,
      expectedCount,
    });
  }
  const headerBytes = 4 + (count + 1) * 4;
  reader.check(base, headerBytes);
  if (base + headerBytes > end) {
    fail(`${label} header exceeds its container.`, 'INVALID_BATTLE_MECHA_ARCHIVE_OFFSETS');
  }
  const bytesInContainer = end - base;
  const offsets = Array.from({ length: count + 1 }, (_, index) => reader.u32(base + 4 + index * 4));
  let previous = headerBytes;
  for (const [index, offset] of offsets.entries()) {
    if (offset === 0 && index < count) continue;
    if (offset < headerBytes || offset > bytesInContainer || offset < previous) {
      fail(`${label} has invalid member offsets.`, 'INVALID_BATTLE_MECHA_ARCHIVE_OFFSETS', {
        base,
        end,
        offsets,
      });
    }
    previous = offset;
  }
  if (offsets.at(-1) !== bytesInContainer) {
    fail(`${label} does not end at its terminal offset.`, 'INVALID_BATTLE_MECHA_ARCHIVE_OFFSETS');
  }
  const firstStored = offsets.find((offset) => offset !== 0);
  if (firstStored !== headerBytes) {
    fail(`${label} has bytes outside its members.`, 'INCOMPLETE_BATTLE_MECHA_ARCHIVE_COVERAGE');
  }
  const entries = Array.from({ length: count }, (_, index) => {
    const relativeOffset = offsets[index];
    if (relativeOffset === 0) {
      return {
        index,
        present: false,
        relativeOffset: 0,
        ...rangeHash(bytes, base, 0),
      };
    }
    const nextRelativeOffset = offsets.slice(index + 1).find((offset) => offset !== 0);
    const offset = base + relativeOffset;
    const entryEnd = base + nextRelativeOffset;
    return {
      index,
      present: entryEnd > offset,
      relativeOffset,
      ...rangeHash(bytes, offset, entryEnd - offset),
    };
  });
  const owned = entries.filter(({ relativeOffset }) => relativeOffset !== 0);
  let cursor = base + headerBytes;
  for (const entry of owned) {
    if (entry.sourceRange.offset !== cursor) {
      fail(`${label} has an unowned byte range.`, 'INCOMPLETE_BATTLE_MECHA_ARCHIVE_COVERAGE');
    }
    cursor += entry.sourceRange.length;
  }
  if (cursor !== end) {
    fail(`${label} does not account for all member bytes.`, 'INCOMPLETE_BATTLE_MECHA_ARCHIVE_COVERAGE');
  }
  return {
    count,
    sourceRange: sourceRange(base, end - base),
    headerRange: sourceRange(base, headerBytes),
    offsets,
    entries,
  };
}

function entryBytes(bytes, entry) {
  return bytes.subarray(
    entry.sourceRange.offset,
    entry.sourceRange.offset + entry.sourceRange.length,
  );
}

function parsePackedUploads(bytes, start, end, label) {
  const reader = new BinaryReader(bytes, label);
  reader.check(start, 4);
  const count = reader.u32(start);
  if (count > 4096) {
    fail(`${label} has too many uploads.`, 'INVALID_BATTLE_MECHA_TEXTURE_COUNT', { count });
  }
  const headerBytes = 4 + count * 4;
  reader.check(start, headerBytes);
  const offsets = Array.from({ length: count }, (_, index) => reader.u32(start + 4 + index * 4));
  if (
    (count === 0 && start + headerBytes !== end)
    || (count > 0 && offsets[0] !== headerBytes)
    || offsets.some((offset, index) => (
      offset < headerBytes
      || start + offset >= end
      || (index > 0 && offset <= offsets[index - 1])
    ))
  ) {
    fail(`${label} has invalid upload offsets.`, 'INVALID_BATTLE_MECHA_TEXTURE_OFFSETS');
  }
  const uploads = offsets.map((relativeOffset, index) => {
    const offset = start + relativeOffset;
    const uploadEnd = index + 1 < count ? start + offsets[index + 1] : end;
    reader.check(offset, 16);
    const tag = reader.u32(offset);
    const widthWords = reader.u16(offset + 12);
    const height = reader.u16(offset + 14);
    const pixelBytes = widthWords * height * 2;
    if (
      (tag !== 0x1100 && tag !== 0x1101)
      || widthWords === 0
      || height === 0
      || offset + 16 + pixelBytes !== uploadEnd
    ) {
      fail(`${label} has an invalid upload entry.`, 'INVALID_BATTLE_MECHA_TEXTURE_ENTRY', {
        index,
        tag,
        widthWords,
        height,
      });
    }
    return {
      index,
      sourceRange: sourceRange(offset, uploadEnd - offset),
      kind: tag === 0x1100 ? 'image' : 'clut',
      tag,
      storedOrigin: { x: reader.u16(offset + 4), y: reader.u16(offset + 6) },
      relativeOrigin: { x: reader.u16(offset + 8), y: reader.u16(offset + 10) },
      widthWords,
      height,
      pixelBytes,
      pixelSha256: sha256(bytes.subarray(offset + 16, uploadEnd)),
      pixelWords: Array.from({ length: widthWords * height }, (_, pixelIndex) => (
        reader.u16(offset + 16 + pixelIndex * 2)
      )),
    };
  });
  return {
    sourceRange: sourceRange(start, end - start),
    headerRange: sourceRange(start, headerBytes),
    count,
    offsets,
    uploads,
  };
}

function parseConfigurationDescriptor(reader, offset, index) {
  const colorPaddingOffsets = [0x17, 0x19, 0x1b, 0x1d, 0x1f, 0x21];
  if (colorPaddingOffsets.some((relativeOffset) => reader.u8(offset + relativeOffset) !== 0)) {
    fail('Battle Gear strand-mesh descriptor has nonzero color padding.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  return {
    index,
    sourceRange: sourceRange(offset, 0x24),
    rootBoneIndex: reader.u16(offset),
    boneIndexBase: reader.u16(offset + 2),
    coordinateScaleQ12: reader.i16(offset + 4),
    localOrigin: [
      reader.i16(offset + 6),
      reader.i16(offset + 8),
      reader.i16(offset + 0x0a),
    ],
    textureOrigin: {
      x: reader.u16(offset + 0x0c),
      y: reader.u16(offset + 0x0e),
    },
    textureSpan: {
      u: reader.u16(offset + 0x10),
      v: reader.u16(offset + 0x12),
    },
    clutX: reader.u16(offset + 0x14),
    colors: [
      {
        red: reader.u8(offset + 0x16),
        green: reader.u8(offset + 0x18),
        blue: reader.u8(offset + 0x1a),
      },
      {
        red: reader.u8(offset + 0x1c),
        green: reader.u8(offset + 0x1e),
        blue: reader.u8(offset + 0x20),
      },
    ],
    attachmentCount: reader.u16(offset + 0x22),
    consumerUnusedRanges: colorPaddingOffsets.map((relativeOffset) => (
      sourceRange(offset + relativeOffset, 1)
    )),
  };
}

function parseAuxiliaryConfiguration(reader, entry, descriptor) {
  const start = entry.sourceRange.offset;
  const end = start + entry.sourceRange.length;
  reader.check(start, 4);
  const rowCount = reader.u16(start);
  const quadCellCount = reader.u16(start + 2);
  let cursor = start + 4;
  if (rowCount < 2 || cursor + rowCount * 8 + 2 > end) {
    fail('Battle Gear strand-mesh data is truncated.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  const rowOrigins = Array.from({ length: rowCount }, (_, index) => [
    reader.i16(cursor + index * 6),
    reader.i16(cursor + index * 6 + 2),
    reader.i16(cursor + index * 6 + 4),
  ]);
  cursor += rowCount * 6;
  const runLengths = Array.from({ length: rowCount }, (_, index) => reader.u16(cursor + index * 2));
  cursor += rowCount * 2;
  const constraintCount = reader.u16(cursor);
  cursor += 2;
  const derivedQuadCellCount = runLengths.slice(1).reduce((total, length, index) => (
    total + Math.min(runLengths[index], length)
  ), 0);
  if (
    runLengths.some((length) => length === 0)
    || runLengths.reduce((total, length) => total + length, 0) !== constraintCount
    || derivedQuadCellCount !== quadCellCount
  ) {
    fail('Battle Gear strand-mesh counts are inconsistent.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  const attachmentBytes = descriptor.attachmentCount * 10;
  if (cursor + constraintCount * 3 + attachmentBytes > end) {
    fail('Battle Gear strand-mesh constraints are truncated.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  const constraintLengths = Array.from(
    { length: constraintCount },
    (_, index) => reader.u16(cursor + index * 2),
  );
  cursor += constraintCount * 2;
  const boneIndexDeltas = Array.from(
    { length: constraintCount },
    (_, index) => reader.u8(cursor + index),
  );
  cursor += constraintCount;
  const attachments = Array.from({ length: descriptor.attachmentCount }, (_, index) => {
    const attachmentOffset = cursor + index * 10;
    return {
      index,
      sourceRange: sourceRange(attachmentOffset, 10),
      runtimeFields: {
        field00: reader.u16(attachmentOffset + 4),
        field02: reader.u16(attachmentOffset + 6),
        field04: reader.u16(attachmentOffset + 8),
        field06: reader.u16(attachmentOffset),
        field0e: reader.u16(attachmentOffset + 2),
      },
    };
  });
  cursor += attachmentBytes;
  const trailerBytes = [...reader.buffer.subarray(cursor, end)];
  let trailer;
  if (trailerBytes.length === 0) trailer = { kind: 'none', bytes: 0 };
  else if (trailerBytes.length === 2 && trailerBytes[0] === 0x77 && trailerBytes[1] === 0x77) {
    trailer = { kind: 'end-marker', bytes: 2 };
  } else if (trailerBytes.length <= 3 && trailerBytes.every((value) => value === 0)) {
    trailer = { kind: 'zero-alignment', bytes: trailerBytes.length };
  } else {
    fail('Battle Gear strand-mesh data has an invalid trailer.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  let constraintIndex = 0;
  return {
    index: entry.index - 1,
    kind: 'strand-mesh',
    sourceRange: entry.sourceRange,
    sha256: entry.sha256,
    descriptor,
    rowCount,
    quadCellCount,
    triangleCount: quadCellCount * 2,
    rows: rowOrigins.map((rawOrigin, index) => {
      const length = runLengths[index];
      const row = {
        index,
        rawOrigin,
        initialPosition: rawOrigin.map((value, axis) => Math.trunc(
          (value + descriptor.localOrigin[axis]) * descriptor.coordinateScaleQ12 / 0x1000,
        )),
        constraints: Array.from({ length }, (_, offset) => ({
          rawLength: constraintLengths[constraintIndex + offset],
          scaledLength: Math.trunc(
            constraintLengths[constraintIndex + offset] * descriptor.coordinateScaleQ12 / 0x1000,
          ),
          boneIndexDelta: boneIndexDeltas[constraintIndex + offset],
          boneIndex: descriptor.boneIndexBase + boneIndexDeltas[constraintIndex + offset],
        })),
      };
      constraintIndex += length;
      return row;
    }),
    constraintCount,
    attachments,
    trailer,
    consumerUnusedRanges: trailer.kind === 'none'
      ? []
      : [sourceRange(cursor, trailer.bytes)],
  };
}

function parseModelConfiguration(bytes, section) {
  const reader = new BinaryReader(bytes, 'Battle Gear model configuration');
  const table = parseRelocatedTable(
    bytes,
    section.sourceRange.offset,
    section.sourceRange.offset + section.sourceRange.length,
    'Battle Gear model configuration',
  );
  if (table.count < 1 || !table.entries[0].present) {
    fail('Battle Gear model has no primary configuration.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  const primaryEntry = table.entries[0];
  if (primaryEntry.sourceRange.length < 0x14) {
    fail('Battle Gear primary configuration is truncated.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  const offset = primaryEntry.sourceRange.offset;
  const auxiliaryCount = reader.u8(offset + 0x12);
  if (
    primaryEntry.sourceRange.length !== 0x14 + auxiliaryCount * 0x24
    || table.count !== auxiliaryCount + 1
  ) {
    fail('Battle Gear auxiliary configuration table is inconsistent.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  const descriptors = Array.from({ length: auxiliaryCount }, (_, index) => (
    parseConfigurationDescriptor(reader, offset + 0x14 + index * 0x24, index)
  ));
  return {
    sourceRange: table.sourceRange,
    tableRange: table.headerRange,
    entryCount: table.count,
    offsets: table.offsets,
    primary: {
      sourceRange: sourceRange(offset, 0x14),
      serializedValue00: reader.i16(offset),
      rawDimensions: [reader.i16(offset + 2), reader.i16(offset + 4), reader.i16(offset + 6)],
      modelScale: reader.i16(offset + 8),
      defaultKeyframeSelector: reader.u8(offset + 0x0a),
      reserved0b: reader.u8(offset + 0x0b),
      renderFlags: reader.u16(offset + 0x0c),
      trailEmitterCount: reader.u8(offset + 0x0e),
      reserved0f: reader.u8(offset + 0x0f),
      imageAnimationCount: reader.u8(offset + 0x10),
      reserved11: reader.u8(offset + 0x11),
      strandMeshCount: auxiliaryCount,
      reserved13: reader.u8(offset + 0x13),
    },
    entries: table.entries,
    strandMeshes: table.entries.slice(1).map((entry, index) => (
      parseAuxiliaryConfiguration(reader, entry, descriptors[index])
    )),
  };
}

function primitiveRecord(primitive) {
  return {
    material: primitive.material,
    positions: Array.from(primitive.positions),
    normals: Array.from(primitive.normals),
    uvs: primitive.uvs === null ? null : Array.from(primitive.uvs),
    colors: primitive.colors === null ? null : Array.from(primitive.colors),
    indices: Array.from(primitive.indices),
  };
}

function modelRecord(decoded, bytes, container, assetId, resourceRole, derivatives) {
  const configuration = parseModelConfiguration(bytes, container.entries[3]);
  if (configuration.primary.modelScale !== decoded.modelConfig.embeddedScale) {
    fail('Battle Gear normalized model scale disagrees with its source.', 'INVALID_BATTLE_MECHA_CONFIGURATION');
  }
  const textureUploads = parsePackedUploads(
    bytes,
    container.entries[0].sourceRange.offset,
    container.entries[0].sourceRange.offset + container.entries[0].sourceRange.length,
    'Battle Gear texture uploads',
  );
  return {
    container: {
      sourceRange: container.sourceRange,
      headerRange: container.headerRange,
      offsets: container.offsets,
      members: container.entries.map(({ index, sourceRange: range, sha256: hash }) => ({
        index,
        sourceRange: range,
        sha256: hash,
      })),
    },
    textureUploads,
    stats: { ...decoded.stats },
    materials: decoded.materials.map((material, index) => ({ index, ...material })),
    textures: decoded.textures.map((texture, index) => {
      if (texture === null) return null;
      const role = `${resourceRole}-texture-${String(index).padStart(3, '0')}`;
      const png = PNG.sync.write({
        width: texture.width,
        height: texture.height,
        data: texture.rgba,
      });
      const derivative = {
        id: role,
        role,
        path: `battle/${assetId.replaceAll(':', '-')}/${role}.png`,
        mediaType: 'image/png',
        width: texture.width,
        height: texture.height,
        bytes: png.length,
        sha256: sha256(png),
      };
      derivatives.push({ ...derivative, id: `${assetId}:${role}`, semanticId: role, png });
      return {
        index,
        width: texture.width,
        height: texture.height,
        rgbaSha256: sha256(texture.rgba),
        derivative,
      };
    }),
    nodes: decoded.nodes.map((node, index) => ({
      index,
      part: node.part,
      parent: node.parent,
      flags: node.flags,
      rotation: [...node.rotation],
      translation: [...node.translation],
    })),
    parts: decoded.parts.map((part, index) => ({
      index,
      primitives: part.primitives.map(primitiveRecord),
    })),
    configuration,
    measurements: decoded.measurements,
  };
}

function operandRecords(words) {
  return words.slice(1).map((value, index) => ({
    index: index + 1,
    unsignedValue: value,
    signedValue: signedWord(value),
  }));
}

function instructionSuccessors(opcode, offset, byteLength, words) {
  if (TERMINAL_OPCODES.has(opcode)) return [];
  if (opcode === 0x32) {
    return [{ kind: 'jump', offset: offset + signedWord(words[1]) }];
  }
  if (opcode === 0x63) {
    return [{ kind: 'jump', offset: offset + signedWord(words[1]) }];
  }
  if (BRANCH_OPCODES.has(opcode)) {
    return [
      { kind: 'fallthrough', offset: offset + byteLength },
      { kind: 'branch', offset: offset + signedWord(words[1]) },
    ];
  }
  if (opcode === 0x36) {
    return [
      { kind: 'fallthrough', offset: offset + byteLength },
      { kind: 'callback', offset: offset + signedWord(words[2]) },
    ];
  }
  return [{ kind: 'fallthrough', offset: offset + byteLength }];
}

export function decodeBattleMechaInstruction(value, offset = 0) {
  const bytes = asBuffer(value, 'Battle Gear animation program');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > bytes.length || (offset & 1) !== 0) {
    throw new RangeError('Battle Gear instruction offset is invalid.');
  }
  const word = bytes.readUInt16LE(offset);
  if (word === 0x7777) {
    return {
      offset,
      opcode: 0x77,
      mnemonic: 'end-marker',
      variant: 'container',
      byteLength: 2,
      argument: 0x77,
      operands: [],
      successors: [],
    };
  }
  const opcode = word & 0xff;
  if (opcode > 0x75) {
    fail('Battle Gear animation contains an invalid opcode.', 'INVALID_BATTLE_MECHA_OPCODE', {
      offset,
      opcode,
    });
  }
  const wordCount = WORD_COUNTS.get(opcode) ?? 1;
  const byteLength = wordCount * 2;
  if (offset + byteLength > bytes.length) {
    fail('Battle Gear animation instruction is truncated.', 'TRUNCATED_BATTLE_MECHA_INSTRUCTION', {
      offset,
      opcode,
      byteLength,
    });
  }
  const words = Array.from({ length: wordCount }, (_, index) => bytes.readUInt16LE(offset + index * 2));
  return {
    offset,
    opcode,
    mnemonic: OPCODE_NAMES[opcode],
    variant: BATTLE_ONLY_OPCODES.has(opcode) ? 'battle' : 'shared',
    byteLength,
    argument: word >>> 8,
    operands: operandRecords(words),
    successors: instructionSuccessors(opcode, offset, byteLength, words),
  };
}

function rangesFromOwner(owner, expected, baseOffset) {
  const ranges = [];
  let index = 0;
  while (index < owner.length) {
    if (owner[index] !== expected) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < owner.length && owner[index] === expected) index += 1;
    ranges.push(sourceRange(baseOffset + start, index - start));
  }
  return ranges;
}

function rangesFromDecodedOwner(owner, baseOffset) {
  const ranges = [];
  let index = 0;
  while (index < owner.length) {
    if (owner[index] === -1) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < owner.length && owner[index] !== -1) index += 1;
    ranges.push(sourceRange(baseOffset + start, index - start));
  }
  return ranges;
}

function decodeSecondaryEventStream(bytes, instruction) {
  const start = instruction.offset + instruction.byteLength;
  const end = instruction.successors[0].offset;
  let cursor = start;
  const events = [];
  for (let index = 0; index < instruction.argument; index += 1) {
    if (cursor + 4 > end) {
      fail(
        'Battle Gear secondary event header is truncated.',
        'INVALID_BATTLE_MECHA_SECONDARY_EVENT_STREAM',
        { instructionOffset: instruction.offset, eventIndex: index },
      );
    }
    const type = bytes[cursor + 2];
    let byteLength = TIMED_EVENT_FIXED_LENGTHS.get(type);
    if (TIMED_EVENT_ENABLED_LENGTHS.has(type)) {
      if (cursor + 6 > end) {
        fail(
          'Battle Gear secondary event payload is truncated.',
          'INVALID_BATTLE_MECHA_SECONDARY_EVENT_STREAM',
          { instructionOffset: instruction.offset, eventIndex: index, type },
        );
      }
      byteLength = bytes[cursor + 4] === 0 ? 0x06 : TIMED_EVENT_ENABLED_LENGTHS.get(type);
    }
    if (!byteLength || cursor + byteLength > end) {
      fail(
        'Battle Gear secondary event has an invalid type or extent.',
        'INVALID_BATTLE_MECHA_SECONDARY_EVENT_STREAM',
        { instructionOffset: instruction.offset, eventIndex: index, type, byteLength },
      );
    }
    events.push(compileTimedEvent({
      index,
      offset: cursor,
      frame: bytes.readInt16LE(cursor),
      type,
      slot: bytes[cursor + 3],
      payload: bytes.subarray(cursor + 4, cursor + byteLength),
    }));
    cursor += byteLength;
  }
  return {
    instructionOffset: instruction.offset,
    sourceRange: sourceRange(start, cursor - start),
    sha256: sha256(bytes.subarray(start, cursor)),
    eventCount: instruction.argument,
    events,
  };
}

function decodeProgram(bytes, animationTable) {
  const roots = animationTable.entries.slice(1)
    .filter(({ present }) => present)
    .map((entry) => entry.sourceRange.offset);
  if (roots.length === 0) {
    fail('Battle Gear animation has no script roots.', 'EMPTY_BATTLE_MECHA_PROGRAM');
  }
  const start = Math.min(...roots);
  const end = animationTable.sourceRange.offset + animationTable.sourceRange.length;
  const owner = new Int32Array(end - start);
  owner.fill(-1);
  const instructions = new Map();
  const queue = [...new Set(roots)];

  function enqueue(target, sourceOffset, kind) {
    if (target < start || target >= end || (target & 1) !== 0) {
      fail('Battle Gear control flow targets outside its program.', 'INVALID_BATTLE_MECHA_BRANCH', {
        sourceOffset,
        kind,
        target,
        start,
        end,
      });
    }
    queue.push(target);
  }

  while (queue.length > 0) {
    const offset = queue.shift();
    if (instructions.has(offset)) continue;
    if (owner[offset - start] !== -1) {
      fail('Battle Gear control flow targets the middle of an instruction.', 'MISALIGNED_BATTLE_MECHA_BRANCH', {
        offset,
        owner: owner[offset - start],
      });
    }
    const instruction = decodeBattleMechaInstruction(bytes, offset);
    for (let byte = 0; byte < instruction.byteLength; byte += 1) {
      const index = offset - start + byte;
      if (index >= owner.length || owner[index] !== -1) {
        fail('Battle Gear animation instructions overlap.', 'OVERLAPPING_BATTLE_MECHA_INSTRUCTIONS', {
          offset,
          overlapOffset: start + index,
        });
      }
      owner[index] = offset;
    }
    for (const successor of instruction.successors) {
      enqueue(successor.offset, offset, successor.kind);
    }
    instructions.set(offset, instruction);
  }

  for (const root of roots) {
    if (!instructions.has(root)) {
      fail('Battle Gear script root did not resolve to an instruction.', 'INVALID_BATTLE_MECHA_SCRIPT_ROOT', {
        root,
      });
    }
  }
  const secondaryEventStreams = [...instructions.values()]
    .filter(({ opcode }) => opcode === 0x63)
    .sort((left, right) => left.offset - right.offset)
    .map((instruction) => {
      const stream = decodeSecondaryEventStream(bytes, instruction);
      for (
        let offset = stream.sourceRange.offset;
        offset < stream.sourceRange.offset + stream.sourceRange.length;
        offset += 1
      ) {
        const index = offset - start;
        if (owner[index] !== -1) {
          fail(
            'Battle Gear secondary event stream overlaps executable bytecode.',
            'OVERLAPPING_BATTLE_MECHA_SECONDARY_EVENT_STREAM',
            { instructionOffset: instruction.offset, overlapOffset: offset },
          );
        }
        owner[index] = instruction.offset;
      }
      return stream;
    });
  return {
    sourceRange: sourceRange(start, end - start),
    sha256: sha256(bytes.subarray(start, end)),
    roots,
    instructions: [...instructions.values()].sort((left, right) => left.offset - right.offset),
    instructionCount: instructions.size,
    secondaryEventStreams,
    decodedRanges: rangesFromDecodedOwner(owner, start),
    consumerUnusedRanges: rangesFromOwner(owner, -1, start),
  };
}

function u16Words(bytes) {
  const reader = new BinaryReader(bytes, 'Battle Gear timed event');
  return Array.from({ length: Math.floor(bytes.length / 2) }, (_, index) => reader.u16(index * 2));
}

function compileTimedEvent(event) {
  const operation = TIMED_EVENT_NAMES[event.type];
  if (!operation) {
    fail('Battle Gear keyframe contains an invalid timed-event type.', 'INVALID_BATTLE_MECHA_TIMED_EVENT', {
      type: event.type,
    });
  }
  const payload = Buffer.from(event.payload);
  let parameters;
  if (event.type === 5) {
    parameters = { soundIds: u16Words(payload) };
  } else if (event.type === 6) {
    parameters = {};
  } else if (event.type === 7) {
    parameters = { boneIndex: payload[0], enabled: (payload[1] & 1) !== 0 };
  } else if (event.type === 8) {
    parameters = {
      dispatchMode: payload[0],
      targetSelector: payload[1],
      commandWords: u16Words(payload.subarray(2)),
    };
  } else {
    parameters = {
      enabled: [2, 3, 4, 9].includes(event.type) ? (payload[0] ?? 0) !== 0 : true,
      payloadWords: u16Words(payload),
    };
  }
  return {
    index: event.index,
    offset: event.offset,
    frame: event.frame,
    slot: event.slot,
    operation,
    parameters,
  };
}

function keyframeRecord(raw, compiled, bytes) {
  if (raw === null) return null;
  return {
    ...compiled,
    sourceRange: sourceRange(raw.offset, raw.end - raw.offset),
    sha256: sha256(bytes.subarray(raw.offset, raw.end)),
    advisoryDescriptorCount: raw.boneCount,
    rotationCount: raw.rotationCount,
    translationCount: raw.translationCount,
    eventStreamOffset: raw.eventOffset,
    events: raw.events.map(compileTimedEvent),
  };
}

export function decodeBattleMechaKeyframes(value, table) {
  const bytes = asBuffer(value, 'Battle auxiliary keyframes');
  const reader = new BinaryReader(bytes, 'Battle auxiliary keyframes');
  return table.entries.map((pointer, index) => {
    // Nonzero duplicate pointers are aliases; retain their original slot index.
    const entry = pointer.relativeOffset === 0 ? pointer : table.entries.find(candidate =>
      candidate.present && candidate.relativeOffset === pointer.relativeOffset) || pointer;
    if (!entry.present) return null;
    const offset = entry.sourceRange.offset;
    const end = offset + entry.sourceRange.length;
    if (entry.sourceRange.length < 0x18) {
      fail('Battle auxiliary keyframe header is truncated.', 'INVALID_BATTLE_MECHA_KEYFRAME', { index });
    }
    reader.check(offset, entry.sourceRange.length);
    const raw = {
      index, offset, end,
      boneCount: reader.u16(offset),
      duration: reader.u16(offset + 2),
      flags: reader.u16(offset + 4),
      mode: reader.u16(offset + 6),
      rotationCount: reader.u16(offset + 0x0c),
      translationCount: reader.u16(offset + 0x0e),
      movementDistance: reader.i16(offset + 0x10),
      eventCount: reader.i16(offset + 0x12),
      eventOffset: reader.u32(offset + 0x14),
      dataOffset: offset + 0x18,
      events: [],
    };
    const descriptorBytes = raw.mode === 0 ? (raw.rotationCount + 1) * 6 : 0;
    const poseBytes = (
      ((raw.flags & 1) === 0 ? raw.rotationCount : 0)
      + ((raw.flags & 2) === 0 ? raw.translationCount : 0)
    ) * 6;
    if (raw.dataOffset + descriptorBytes + poseBytes > end) {
      fail('Battle auxiliary keyframe pose is truncated.', 'INVALID_BATTLE_MECHA_KEYFRAME', { index });
    }
    let cursor = offset + raw.eventOffset;
    if (raw.eventCount > 0 && (cursor < raw.dataOffset || cursor > end)) {
      fail('Battle auxiliary events lie outside their keyframe.', 'INVALID_BATTLE_MECHA_TIMED_EVENT', { index });
    }
    for (let eventIndex = 0; eventIndex < raw.eventCount; eventIndex += 1) {
      if (cursor + 4 > end) {
        fail('Battle auxiliary event header is truncated.', 'INVALID_BATTLE_MECHA_TIMED_EVENT', { index, eventIndex });
      }
      const type = reader.u8(cursor + 2);
      let length = TIMED_EVENT_FIXED_LENGTHS.get(type);
      if (TIMED_EVENT_ENABLED_LENGTHS.has(type)) {
        if (cursor + 6 > end) {
          fail('Battle auxiliary event is truncated.', 'INVALID_BATTLE_MECHA_TIMED_EVENT', { index, eventIndex });
        }
        length = reader.u8(cursor + 4) === 0 ? 6 : TIMED_EVENT_ENABLED_LENGTHS.get(type);
      }
      if (!length || cursor + length > end) {
        fail('Battle auxiliary event type or extent is invalid.', 'INVALID_BATTLE_MECHA_TIMED_EVENT', { index, eventIndex, type });
      }
      raw.events.push({
        index: eventIndex,
        offset: cursor - offset,
        frame: reader.i16(cursor),
        type,
        slot: reader.u8(cursor + 3),
        payload: bytes.subarray(cursor + 4, cursor + length),
      });
      cursor += length;
    }
    const compiled = compileSceneModelAnimationKeyframe(bytes.subarray(0, end), raw);
    if (compiled.diagnostics.length > 0) {
      fail('Battle auxiliary keyframe decoding is incomplete.', 'INVALID_BATTLE_MECHA_KEYFRAME', {
        index, diagnostics: compiled.diagnostics,
      });
    }
    const keyframe = keyframeRecord(raw, compiled.keyframe, bytes);
    const referencedBones = [
      ...keyframe.directPose.rotations.map(({ nodeIndex }) => nodeIndex + 1),
      ...keyframe.directPose.translations.map(({ nodeIndex }) => nodeIndex + 1),
      ...keyframe.tracks.map(({ boneIndex }) => boneIndex),
      ...keyframe.events.filter(({ operation }) => operation === 'set-bone-visibility')
        .map(({ parameters }) => parameters.boneIndex),
    ];
    return {
      ...keyframe,
      referencedRuntimeBoneCount: Math.max(0, ...referencedBones.map((boneIndex) => boneIndex + 1)),
    };
  });
}

export {
  parseRelocatedTable as parseBattleMechaRelocatedTable,
  parsePackedUploads as parseBattleMechaPackedUploads,
  decodeProgram as decodeBattleMechaProgram,
  nestedSequenceRecord as decodeBattleMechaSequence,
};

function nestedSequenceRecord(bytes, context, entry) {
  const sequenceBytes = entryBytes(bytes, entry);
  const sequenceContext = {
    ...context,
    logicalBytes: sequenceBytes.length,
    sha256: sha256(sequenceBytes),
  };
  const decoded = decodeSoundSequence(sequenceBytes, sequenceContext);
  if (!decoded.complete || decoded.kind !== 'sound-effect-sequence') {
    fail('Battle Gear auxiliary sequence is incomplete.', 'INVALID_BATTLE_MECHA_SEQUENCE');
  }
  const {
    schema,
    id,
    complete,
    decoder,
    source,
    ...sequence
  } = decoded;
  return {
    sourceRange: entry.sourceRange,
    sha256: entry.sha256,
    decoder,
    ...sequence,
  };
}

function decodeAnimation(bytes, context, nodes, modelScale, expectSequence) {
  const root = parseRelocatedTable(bytes, 0, bytes.length, 'Battle Gear animation root', 2);
  const animationEntry = root.entries[0];
  if (!animationEntry.present) {
    fail('Battle Gear animation root has no animation data.', 'INVALID_BATTLE_MECHA_ANIMATION');
  }
  const animationTable = parseRelocatedTable(
    bytes,
    animationEntry.sourceRange.offset,
    animationEntry.sourceRange.offset + animationEntry.sourceRange.length,
    'Battle Gear animation table',
  );
  if (animationTable.count < 2 || !animationTable.entries[0].present) {
    fail('Battle Gear animation table has no keyframes or scripts.', 'INVALID_BATTLE_MECHA_ANIMATION');
  }
  const keyframeEntry = animationTable.entries[0];
  const keyframeTable = parseRelocatedTable(
    bytes,
    keyframeEntry.sourceRange.offset,
    keyframeEntry.sourceRange.offset + keyframeEntry.sourceRange.length,
    'Battle Gear keyframe table',
  );
  const auxiliaryEntry = root.entries[1];
  const auxiliaryTable = parseRelocatedTable(
    bytes,
    auxiliaryEntry.sourceRange.offset,
    auxiliaryEntry.sourceRange.offset + auxiliaryEntry.sourceRange.length,
    'Battle Gear animation auxiliary table',
    6,
  );
  const presentAuxiliary = auxiliaryTable.entries.filter(({ present }) => present);
  if (
    (expectSequence && (presentAuxiliary.length !== 1 || presentAuxiliary[0].index !== 1))
    || (!expectSequence && presentAuxiliary.length !== 0)
  ) {
    fail('Battle Gear animation auxiliary members do not match their retail layout.', 'INVALID_BATTLE_MECHA_AUXILIARY_DATA');
  }

  const parsed = parseSceneModelAnimationProgram(bytes, nodes, { modelScale });
  const compiled = compileSceneModelAnimationProgram(parsed);
  const keyframeDiagnostics = compiled.diagnostics.filter(({ details }) => (
    Number.isSafeInteger(details?.keyframeIndex)
    && !Number.isSafeInteger(details?.scriptIndex)
  ));
  if (keyframeDiagnostics.length > 0) {
    fail('Battle Gear keyframe decoding is incomplete.', 'INVALID_BATTLE_MECHA_KEYFRAME', {
      diagnostics: keyframeDiagnostics,
    });
  }
  if (
    parsed.keyframes.length !== keyframeTable.count
    || parsed.scripts.length !== animationTable.count - 1
  ) {
    fail('Battle Gear parsed animation does not match its tables.', 'INVALID_BATTLE_MECHA_ANIMATION');
  }
  const program = decodeProgram(bytes, animationTable);
  return {
    container: {
      sourceRange: root.sourceRange,
      headerRange: root.headerRange,
      offsets: root.offsets,
      animationTable: {
        sourceRange: animationTable.sourceRange,
        headerRange: animationTable.headerRange,
        offsets: animationTable.offsets,
        roots: animationTable.entries.slice(1).map((entry, index) => ({
          animationId: index,
          present: entry.present,
          sourceRange: entry.sourceRange,
          sha256: entry.sha256,
        })),
      },
      keyframeTable: {
        sourceRange: keyframeTable.sourceRange,
        headerRange: keyframeTable.headerRange,
        offsets: keyframeTable.offsets,
      },
      auxiliaryTable: {
        sourceRange: auxiliaryTable.sourceRange,
        headerRange: auxiliaryTable.headerRange,
        offsets: auxiliaryTable.offsets,
      },
    },
    fps: parsed.fps,
    modelScale: parsed.modelScale,
    boneCount: nodes.length,
    defaultPose: compiled.defaultPose,
    keyframes: parsed.keyframes.map((keyframe, index) => (
      keyframeRecord(keyframe, compiled.keyframes[index], bytes)
    )),
    program,
    soundEffects: expectSequence
      ? nestedSequenceRecord(bytes, context, presentAuxiliary[0])
      : null,
  };
}

export function decodeEmbeddedBattleMechaResource({
  modelBytes: modelValue,
  animationBytes: animationValue,
  discNumber,
  visualId,
  assetId,
  sourceRanges,
  sourceContext,
}) {
  if (discNumber !== 1 && discNumber !== 2) {
    throw new RangeError('Disc number must be 1 or 2.');
  }
  const visualMatch = /^enemy-visual-(0[0-7])$/.exec(visualId);
  if (!visualMatch) {
    throw new TypeError('Embedded Battle mecha visual ID is invalid.');
  }
  const modelBytes = asBuffer(modelValue, 'Embedded Battle mecha model');
  const animationBytes = asBuffer(animationValue, 'Embedded Battle mecha animation');
  const validRange = (range, length) => (
    range
    && Number.isSafeInteger(range.offset)
    && range.offset >= 0
    && Number.isSafeInteger(range.length)
    && range.length === length
  );
  if (
    !validRange(sourceRanges?.model, modelBytes.length)
    || !validRange(sourceRanges?.animation, animationBytes.length)
    || sourceContext?.discNumber !== discNumber
    || sourceRanges.model.offset + sourceRanges.model.length > sourceContext.logicalBytes
    || sourceRanges.animation.offset + sourceRanges.animation.length > sourceContext.logicalBytes
  ) {
    throw new TypeError('Embedded Battle mecha source contract is invalid.');
  }

  const modelContainer = parseRelocatedTable(
    modelBytes,
    0,
    modelBytes.length,
    'Embedded Battle mecha model root',
    4,
  );
  if (modelContainer.entries.some(({ present }) => !present)) {
    fail('Embedded Battle mecha model root has an empty member.', 'INVALID_BATTLE_MECHA_MODEL');
  }
  const animationRoot = parseRelocatedTable(
    animationBytes,
    0,
    animationBytes.length,
    'Embedded Battle mecha animation root',
    2,
  );
  const auxiliaryEntry = animationRoot.entries[1];
  if (!animationRoot.entries[0].present || !auxiliaryEntry.present) {
    fail('Embedded Battle mecha animation root has an empty member.', 'INVALID_BATTLE_MECHA_ANIMATION');
  }
  const auxiliaryTable = parseRelocatedTable(
    animationBytes,
    auxiliaryEntry.sourceRange.offset,
    auxiliaryEntry.sourceRange.offset + auxiliaryEntry.sourceRange.length,
    'Embedded Battle mecha animation auxiliary table',
    6,
  );
  const presentAuxiliary = auxiliaryTable.entries.filter(({ present }) => present);
  const expectSequence = presentAuxiliary.length === 1 && presentAuxiliary[0].index === 1;
  if (!expectSequence && presentAuxiliary.length !== 0) {
    fail(
      'Embedded Battle mecha animation has an invalid auxiliary layout.',
      'INVALID_BATTLE_MECHA_AUXILIARY_DATA',
    );
  }

  const modelNumber = Number(visualMatch[1]) + 1;
  const decoded = decodeSceneModel({
    animationBuffer: animationBytes,
    modelBuffer: modelBytes,
    discNumber,
    modelNumber,
    runtimeContext: null,
    onProgress() {},
  });
  const nestedAnimationContext = {
    ...sourceContext,
    logicalBytes: animationBytes.length,
    sha256: sha256(animationBytes),
  };
  const derivatives = [];
  return {
    model: modelRecord(decoded, modelBytes, modelContainer, assetId, visualId, derivatives),
    animation: decodeAnimation(
      animationBytes,
      nestedAnimationContext,
      decoded.nodes,
      decoded.modelConfig.embeddedScale,
      expectSequence,
    ),
    derivatives,
  };
}

function decodeModelAndAnimation(modelBytes, animationBytes, animationContext, discNumber, gearId, assetId, derivatives, expectSequence = true) {
  const modelContainer = parseRelocatedTable(
    modelBytes,
    0,
    modelBytes.length,
    'Battle Gear model root',
    4,
  );
  if (modelContainer.entries.some(({ present }) => !present)) {
    fail('Battle Gear model root has an empty member.', 'INVALID_BATTLE_MECHA_MODEL');
  }
  const decoded = decodeSceneModel({
    animationBuffer: animationBytes,
    modelBuffer: modelBytes,
    discNumber,
    modelNumber: gearId + 1,
    runtimeContext: null,
    onProgress() {},
  });
  const model = modelRecord(decoded, modelBytes, modelContainer, assetId, 'base', derivatives);
  const animation = decodeAnimation(
    animationBytes,
    animationContext,
    decoded.nodes,
    decoded.modelConfig.embeddedScale,
    expectSequence,
  );
  return { model, animation };
}

/** EC46 selector0 uses the dedicated Seibzehn summon pair in archive40. */
export function decodeBattleSummonedMechaResource({ modelBytes, modelContext, animationBytes, animationContext }) {
  for (const [value, context, sourceId, digest] of [
    [modelBytes, modelContext, 'xg:d1:file-003915', 'e1f2cfe95857e760bad3213689cc05998dc34a5dcc74cfbc712c4bb3588b5c58'],
    [animationBytes, animationContext, 'xg:d1:file-003916', '4df9dee8f28660175559bed436dcc7bc564e5aabaadb00efef0f4dc1abfe916c'],
  ]) {
    assertSourceContext(value, context);
    if (context.sourceId !== sourceId || context.sha256 !== digest) throw new Error('Battle summoned mecha source identity changed.');
  }
  const id = 'xg:d1:asset:battle:effect-mecha-0', derivatives = [];
  const decoded = decodeModelAndAnimation(Buffer.from(modelBytes), Buffer.from(animationBytes), animationContext, 1, 8, id, derivatives, false);
  const gear = { gearId: 8, resourceIndex: 0, modelFileNumber: 1, animationFileNumber: 2,
    model: decoded.model, animation: decoded.animation, optionalResources: [] };
  return { semantic: { complete: true, gear }, derivatives, assets: [{
    schema: { name: CONTENT_FAMILY_SCHEMAS.battle.name, version: CONTENT_FAMILY_SCHEMAS.battle.version },
    id, family: 'battle', kind: 'gear-resource', dependencies: [],
    provenance: { decoder: { ...BATTLE_MECHA_RESOURCE_DECODER }, sources: [
      sourceProvenance(modelContext, 'effect-mecha-model'), sourceProvenance(animationContext, 'effect-mecha-animation')] },
    coordinates: [], timing: [], artifacts: derivatives.map(({ role, path, mediaType, bytes, sha256 }) => ({ role, path, mediaType, bytes, sha256 })),
    diagnostics: [], data: { gears: [gear] },
  }] };
}

function parseOptionalDescriptor(bytes, entry, expectedCount) {
  if (entry.sourceRange.length !== 20) {
    fail('Battle Gear optional descriptor block has an invalid size.', 'INVALID_BATTLE_MECHA_OPTIONAL_DESCRIPTOR');
  }
  const reader = new BinaryReader(bytes, 'Battle Gear optional descriptor');
  const offset = entry.sourceRange.offset;
  const count = reader.i16(offset);
  const consumerUnused = reader.u16(offset + 2);
  if (
    count < 0
    || count > 2
    || (expectedCount !== null && count !== expectedCount)
    || consumerUnused !== 0
  ) {
    fail('Battle Gear optional descriptor count is invalid.', 'INVALID_BATTLE_MECHA_OPTIONAL_DESCRIPTOR', {
      count,
      expectedCount,
      consumerUnused,
    });
  }
  const inactive = Array.from({ length: 2 - count }, (_, index) => {
    const recordOffset = offset + 4 + (count + index) * 8;
    const halfwords = Array.from({ length: 4 }, (unused, word) => reader.u16(recordOffset + word * 2));
    if (halfwords[0] !== 0xffff || halfwords.slice(1).some((value) => value !== 0)) {
      fail('Battle Gear optional descriptor has a noncanonical inactive slot.', 'INVALID_BATTLE_MECHA_OPTIONAL_DESCRIPTOR', {
        slot: count + index,
        halfwords,
      });
    }
    return {
      index: count + index,
      sourceRange: sourceRange(recordOffset, 8),
      halfwords,
    };
  });
  return {
    sourceRange: entry.sourceRange,
    count,
    consumerUnused,
    active: Array.from({ length: count }, (_, index) => {
      const recordOffset = offset + 4 + index * 8;
      return {
        index,
        sourceRange: sourceRange(recordOffset, 8),
        parentBone: reader.u16(recordOffset),
        localOffset: [
          reader.i16(recordOffset + 2),
          reader.i16(recordOffset + 4),
          reader.i16(recordOffset + 6),
        ],
      };
    }),
    inactive,
  };
}

function decodeAnimatedChildResource(bytes, context, gearId, resourceIndex, attachmentCount, assetId, derivatives) {
  const root = parseRelocatedTable(bytes, 0, bytes.length, 'Battle Gear animated child resource', 3);
  const descriptor = parseOptionalDescriptor(bytes, root.entries[0], attachmentCount);
  const animationBytes = entryBytes(bytes, root.entries[1]);
  const modelBytes = entryBytes(bytes, root.entries[2]);
  const modelContainer = parseRelocatedTable(modelBytes, 0, modelBytes.length, 'Battle Gear child model root', 4);
  const decoded = decodeSceneModel({
    animationBuffer: animationBytes,
    modelBuffer: modelBytes,
    discNumber: context.discNumber,
    modelNumber: gearId + 1,
    runtimeContext: null,
    onProgress() {},
  });
  const rebasedContext = {
    ...context,
    logicalBytes: animationBytes.length,
    sha256: sha256(animationBytes),
  };
  return {
    resourceIndex,
    kind: 'animated-child-model',
    sourceRange: sourceRange(0, bytes.length),
    container: {
      headerRange: root.headerRange,
      offsets: root.offsets,
      members: root.entries.map(({ index, sourceRange: range, sha256: hash }) => ({
        index,
        sourceRange: range,
        sha256: hash,
      })),
    },
    descriptor,
    model: {
      containerOffset: root.entries[2].sourceRange.offset,
      ...modelRecord(decoded, modelBytes, modelContainer, assetId, `child-${String(resourceIndex).padStart(2, '0')}`, derivatives),
    },
    animation: {
      containerOffset: root.entries[1].sourceRange.offset,
      ...decodeAnimation(
      animationBytes,
      rebasedContext,
      decoded.nodes,
      decoded.modelConfig.embeddedScale,
      false,
      ),
    },
  };
}

function decodeTextureVariant(bytes, resourceIndex) {
  const root = parseRelocatedTable(bytes, 0, bytes.length, 'Battle Gear texture variant', 2);
  const descriptor = parseOptionalDescriptor(bytes, root.entries[0], 0);
  return {
    resourceIndex,
    kind: 'texture-variant',
    sourceRange: sourceRange(0, bytes.length),
    container: {
      headerRange: root.headerRange,
      offsets: root.offsets,
      members: root.entries.map(({ index, sourceRange: range, sha256: hash }) => ({
        index,
        sourceRange: range,
        sha256: hash,
      })),
    },
    descriptor,
    textureUploads: parsePackedUploads(
      bytes,
      root.entries[1].sourceRange.offset,
      root.entries[1].sourceRange.offset + root.entries[1].sourceRange.length,
      'Battle Gear texture-variant uploads',
    ),
  };
}

function assertContext(bytes, context, fileNumber, discNumber = null) {
  try {
    assertSourceContext(bytes, context);
  } catch (error) {
    throw new TypeError('Battle Gear decoder requires exact source contexts.', { cause: error });
  }
  const expectedFlatIndex = BATTLE_MECHA_FIRST_FLAT_INDEX[context.discNumber] + fileNumber - 1;
  if (
    (discNumber !== null && context.discNumber !== discNumber)
    || context.directoryOrdinal !== BATTLE_MECHA_DIRECTORY_ORDINAL
    || context.fileIndex !== fileNumber - 1
    || context.flatIndex !== expectedFlatIndex
    || context.storageLayout !== 'ordinary'
  ) {
    throw new TypeError('Battle Gear decoder requires exact source contexts.');
  }
}

export function battleGearResourceAssetId(discNumber, gearId) {
  if (discNumber !== 1 && discNumber !== 2) throw new RangeError('Disc number must be 1 or 2.');
  if (!Number.isSafeInteger(gearId) || gearId < 0 || gearId >= BATTLE_GEAR_COUNT) {
    throw new RangeError(`Battle Gear ID must be between 0 and ${BATTLE_GEAR_COUNT - 1}.`);
  }
  return `xg:d${discNumber}:asset:battle:gear-resource-${String(gearId).padStart(2, '0')}`;
}

function sourceProvenance(context, role) {
  return {
    id: context.sourceId,
    role,
    sha256: context.sha256,
    bytes: context.logicalBytes,
    ranges: [sourceRange(0, context.logicalBytes)],
  };
}

export function decodeBattleGearResourceGroup({
  gearId,
  modelBytes: modelValue,
  modelContext,
  animationBytes: animationValue,
  animationContext,
  optionalResources = [],
}) {
  if (!Number.isSafeInteger(gearId) || gearId < 0 || gearId >= BATTLE_GEAR_COUNT) {
    throw new RangeError(`Battle Gear ID must be between 0 and ${BATTLE_GEAR_COUNT - 1}.`);
  }
  const mapping = BATTLE_GEAR_RESOURCE_MAP[gearId];
  if (!Array.isArray(optionalResources) || optionalResources.length !== mapping.optionalResourceCount) {
    throw new TypeError('Battle Gear decoder requires its exact optional resource set.');
  }
  const modelBytes = asBuffer(modelValue, 'Battle Gear model');
  const animationBytes = asBuffer(animationValue, 'Battle Gear animation');
  assertContext(modelBytes, modelContext, mapping.modelFileNumber);
  assertContext(animationBytes, animationContext, mapping.animationFileNumber, modelContext.discNumber);
  const optionalInputs = optionalResources.map((resource, index) => {
    const bytes = asBuffer(resource?.bytes, 'Battle Gear optional resource');
    const context = resource?.context;
    assertContext(bytes, context, mapping.optionalFileNumbers[index], modelContext.discNumber);
    return { bytes, context };
  });

  const assetId = battleGearResourceAssetId(modelContext.discNumber, gearId);
  const derivatives = [];
  const base = decodeModelAndAnimation(
    modelBytes,
    animationBytes,
    animationContext,
    modelContext.discNumber,
    gearId,
    assetId,
    derivatives,
  );
  const optional = optionalInputs.map(({ bytes, context }, index) => (
    mapping.optionalKind === 'texture-variant'
      ? decodeTextureVariant(bytes, index + 1)
      : decodeAnimatedChildResource(
        bytes,
        context,
        gearId,
        index + 1,
        gearId === 5 || gearId === 13 ? 2 : 1,
        assetId,
        derivatives,
      )
  ));
  const unresolvedRanges = [];
  const complete = true;
  const gear = {
    gearId,
    modelFileNumber: mapping.modelFileNumber,
    animationFileNumber: mapping.animationFileNumber,
    model: base.model,
    animation: base.animation,
    optionalResources: optional,
    runtimeRequirements: [
      'battle-entity-state',
      'battle-camera-and-terrain',
      'battle-effects',
      'battle-resource-loader',
      'battle-audio-sample-bank',
    ],
  };
  const semantic = validateCleanContentValue({
    kind: 'battle-mecha-resource',
    complete,
    gearId,
    mapping,
    gear,
    unresolvedRanges,
  }, `Battle Gear ${gearId} semantic decode`);
  const diagnostics = [];
  const contexts = [modelContext, animationContext, ...optionalInputs.map(({ context }) => context)];
  const asset = {
    schema: {
      name: CONTENT_FAMILY_SCHEMAS.battle.name,
      version: CONTENT_FAMILY_SCHEMAS.battle.version,
    },
    id: assetId,
    family: 'battle',
    kind: 'gear-resource',
    dependencies: [],
    provenance: {
      decoder: { ...BATTLE_MECHA_RESOURCE_DECODER },
      sources: [
        sourceProvenance(modelContext, 'gear-model'),
        sourceProvenance(animationContext, 'gear-animation'),
        ...optionalInputs.map(({ context }, index) => (
          sourceProvenance(context, `${mapping.optionalKind}-${String(index + 1).padStart(2, '0')}`)
        )),
      ],
    },
    coordinates: [],
    timing: [],
    artifacts: derivatives.map(({ role, path, mediaType, bytes, sha256: hash }) => ({
      role, path, mediaType, bytes, sha256: hash,
    })),
    diagnostics,
    data: { gears: [gear] },
  };
  validateContentAssetRecord(asset);
  contexts.forEach((context, index) => verifyDecoderDidNotMutate(
    index === 0 ? modelBytes : index === 1 ? animationBytes : optionalInputs[index - 2].bytes,
    context,
  ));
  return {
    semantic,
    assets: [asset],
    derivatives,
    resolutions: contexts.map((context) => ({
      sourceId: context.sourceId,
      disposition: complete ? 'runtime-asset' : 'partial-runtime-asset',
      family: 'battle',
      role: 'mecha-resource',
      decoder: { ...BATTLE_MECHA_RESOURCE_DECODER },
      outputIds: [assetId],
      diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
    })),
  };
}
