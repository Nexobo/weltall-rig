import { XenoFormatError } from '../xeno/binary-reader.js';

// F3 800c1a84..1b84; vertex preparation 800b1ea0..1f08; resident
// mode15 registration 80024730..248b4/80025224; draw 800257f0..25a84.
// Actor mode is preserved: F3 does not itself install the mode15 renderer.
export const BATTLE_TMD_PLAYBACK = Object.freeze({
  requiredContexts: [
    'battle-actor-model-and-render-state',
    'battle-model-light-and-color-matrices',
    'battle-camera-model-projection-and-depth',
  ],
  attach: {
    selectedObjectIndex: 0,
    priorPrimitiveState: 'release',
    rendererSelection: 'preserve-current-actor-renderer',
    sourceGeometry: 'retain-immutable-resource',
  },
  clear: { selectedModel: 'clear', primitiveState: 'release', sourceResource: 'retain' },
  vertexPreparation: {
    stateScope: 'loaded-model-resource-instance',
    initialStateField: 'verticesAlreadyShifted',
    condition: 'actor-camera-scale-nonzero-and-not-already-shifted',
    operation: 'left-shift-each-coordinate-and-wrap-signed16',
    shift: 3,
    normalTreatment: 'unchanged',
    completionState: 'mark-vertices-already-shifted',
  },
  draw: {
    condition: 'active-actor-renderer-is-battle-tmd',
    primitiveOrder: 'source-order',
    modelTransform: 'current-actor-model-matrix',
    translation: 'signed-integer-part-of-actor-position',
    cameraTransform: 'compose-camera-and-model-unless-actor-bypasses-camera',
    lighting: {
      mode: 'per-primitive-lighting',
      state: 'actor-model-light-and-color-matrices',
      refreshCondition: 'actor-model-lighting-update-enabled',
      refreshedBackgroundRgb: [32, 32, 32],
    },
    projectionCenter: {
      source: 'battle-camera',
      overrideCondition: 'actor-fixed-projection-center-enabled',
      override: [160, 112],
      restoreAfterDraw: true,
    },
    depth: {
      source: 'projected-primitive-depth',
      normalShift: 'battle-depth-shift',
      normalBias: 'actor-model-depth-bias',
      overrideCondition: 'actor-model-depth-override-enabled',
      overrideShift: 16,
      overrideBias: 4076,
      minimumOrder: 5,
      maximumOrder: 4095,
      belowMinimum: 'clamp',
      aboveMaximum: 'discard',
    },
  },
});

// Packet header mode/flag/olen/ilen combinations observed in both indexed discs.
// Vertex offsets agree with retail polygon-shatter constructor 801fc7d4..89d0.
// Color/UV copying and packet stepping are authenticated at 800b1720..1e6c.
const PACKETS = new Map([
  [0x20, 0, 4, 3, [10, 12, 14], [8], [4]],
  [0x21, 1, 4, 3, [8, 10, 12], [], [4]],
  [0x22, 0, 4, 3, [10, 12, 14], [8], [4]],
  [0x23, 1, 4, 3, [8, 10, 12], [], [4]],
  [0x24, 0, 7, 5, [18, 20, 22], [16], []],
  [0x25, 1, 7, 6, [20, 22, 24], [], [16]],
  [0x26, 0, 7, 5, [18, 20, 22], [16], []],
  [0x27, 1, 7, 6, [20, 22, 24], [], [16]],
  [0x28, 0, 5, 4, [10, 12, 14, 16], [8], [4]],
  [0x29, 1, 5, 3, [8, 10, 12, 14], [], [4]],
  [0x2c, 0, 9, 7, [22, 24, 26, 28], [], []],
  [0x2d, 1, 9, 7, [24, 26, 28, 30], [], [20]],
  [0x2e, 0, 9, 7, [22, 24, 26, 28], [], []],
  [0x2f, 1, 9, 7, [24, 26, 28, 30], [], [20]],
  [0x31, 1, 6, 5, [16, 18, 20], [], [4, 8, 12]],
  [0x33, 1, 6, 5, [16, 18, 20], [], [4, 8, 12]],
  [0x34, 0, 9, 6, [18, 22, 26], [16, 20, 24], []],
  [0x36, 0, 9, 6, [18, 22, 26], [16, 20, 24], []],
  [0x39, 1, 8, 6, [20, 22, 24, 26], [], [4, 8, 12, 16]],
  [0x3b, 1, 8, 6, [20, 22, 24, 26], [], [4, 8, 12, 16]],
].map(([mode, flag, olen, ilen, vertices, normals, colors]) => [
  `${mode}/${flag}/${olen}/${ilen}`, { vertices, normals, colors },
]));

function fail(message, details) {
  throw new XenoFormatError(message, 'INVALID_BATTLE_TMD', details);
}

function rangesFor(coverage, state, sourceOffset) {
  const ranges = [];
  for (let offset = 0; offset < coverage.length;) {
    if (coverage[offset] !== state) { offset++; continue; }
    const start = offset++;
    while (offset < coverage.length && coverage[offset] === state) offset++;
    ranges.push({ offset: sourceOffset + start, length: offset - start });
  }
  return ranges;
}

/** Decode object zero of the retail Battle F3 embedded TMD, without mutating it. */
export function decodeBattleTmdModel(value, targetOffset) {
  if (!(value instanceof Uint8Array)) throw new TypeError('Battle TMD decoding requires bytes.');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const need = (offset, length, label) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < targetOffset || length < 0 || offset + length > bytes.length) {
      fail(`Battle TMD ${label} exceeds its containing animation.`, { offset, length, animationBytes: bytes.length });
    }
  };
  if (!Number.isInteger(targetOffset) || targetOffset < 0 || targetOffset % 4 !== 0) {
    fail('Battle TMD target must be a nonnegative aligned offset.', { targetOffset });
  }
  need(targetOffset, 12, 'header');
  if (bytes.readUInt32LE(targetOffset) !== 0x41) fail('Battle TMD magic is invalid.', { targetOffset });
  const flags = bytes.readUInt32LE(targetOffset + 4);
  const objectCount = bytes.readUInt32LE(targetOffset + 8);
  const diagnostics = [];
  if (flags !== 0 || objectCount !== 1) {
    return {
      complete: false,
      model: null,
      diagnostics: [{ code: 'BATTLE_TMD_OBJECT_TABLE_UNVERIFIED', message: 'Battle TMD header flags or object count lack verified corpus semantics.', details: { targetOffset, flags, objectCount } }],
      consumption: { sourceOffset: targetOffset, byteLength: 12, decodedRanges: [{ offset: targetOffset, length: 12 }], consumerUnusedRanges: [], unresolvedRanges: [] },
    };
  }

  // 800b168c returns model + 12 + objectIndex*28. All three pointers are
  // relative to that selected object record (800b16bc, 800b1ecc).
  const objectOffset = targetOffset + 12;
  need(objectOffset, 28, 'object record');
  const vertexOffset = objectOffset + bytes.readUInt32LE(objectOffset);
  const vertexCount = bytes.readUInt32LE(objectOffset + 4);
  const normalOffset = objectOffset + bytes.readUInt32LE(objectOffset + 8);
  const normalCount = bytes.readUInt32LE(objectOffset + 12);
  const primitiveOffset = objectOffset + bytes.readUInt32LE(objectOffset + 16);
  const primitiveCount = bytes.readUInt32LE(objectOffset + 20);
  const authoredScaleWord = bytes.readUInt32LE(objectOffset + 24);
  for (const offset of [vertexOffset, normalOffset, primitiveOffset]) {
    if (offset % 4 !== 0) fail('Battle TMD table offset is unaligned.', { offset });
  }
  need(vertexOffset, vertexCount * 8, 'vertex table');
  need(normalOffset, normalCount * 8, 'normal table');
  need(primitiveOffset, primitiveCount * 4, 'primitive headers');
  const readVector = offset => [bytes.readInt16LE(offset), bytes.readInt16LE(offset + 2), bytes.readInt16LE(offset + 4)];
  const vertices = Array.from({ length: vertexCount }, (_, index) => readVector(vertexOffset + index * 8));
  const normals = Array.from({ length: normalCount }, (_, index) => readVector(normalOffset + index * 8));
  const primitives = [];
  const decoded = [{ offset: targetOffset, length: 40 }];
  const unresolved = [];
  for (let index = 0; index < vertexCount; index++) decoded.push({ offset: vertexOffset + index * 8, length: 6 });
  for (let index = 0; index < normalCount; index++) decoded.push({ offset: normalOffset + index * 8, length: 6 });
  let packetOffset = primitiveOffset;
  for (let index = 0; index < primitiveCount; index++) {
    need(packetOffset, 4, 'primitive header');
    const olen = bytes[packetOffset];
    const ilen = bytes[packetOffset + 1];
    const flag = bytes[packetOffset + 2];
    const mode = bytes[packetOffset + 3];
    const packetBytes = (ilen + 1) * 4;
    need(packetOffset, packetBytes, 'primitive payload');
    decoded.push({ offset: packetOffset, length: 4 });
    const layout = PACKETS.get(`${mode}/${flag}/${olen}/${ilen}`);
    if (!layout) {
      diagnostics.push({ code: 'BATTLE_TMD_PACKET_LAYOUT_UNVERIFIED', message: 'Battle TMD primitive packet has no verified layout.', details: { index, offset: packetOffset, olen, ilen, flag, mode } });
      unresolved.push({ offset: packetOffset + 4, length: packetBytes - 4 });
      packetOffset += packetBytes;
      continue;
    }
    const readIndex = (relative, count, kind) => {
      const offset = packetOffset + relative;
      const value = bytes.readUInt16LE(offset);
      if (value >= count) fail(`Battle TMD ${kind} index is outside its table.`, { primitiveIndex: index, offset, value, count });
      decoded.push({ offset, length: 2 });
      return value;
    };
    const vertexIndices = layout.vertices.map(relative => readIndex(relative, vertexCount, 'vertex'));
    const normalIndices = layout.normals.map(relative => readIndex(relative, normalCount, 'normal'));
    const colors = layout.colors.map(relative => {
      const offset = packetOffset + relative;
      decoded.push({ offset, length: 3 });
      return [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
    });
    const textured = (mode & 4) !== 0;
    let texture = null;
    if (textured) {
      const uvs = vertexIndices.map((_, vertexIndex) => {
        const offset = packetOffset + 4 + vertexIndex * 4;
        decoded.push({ offset, length: 2 });
        return [bytes[offset], bytes[offset + 1]];
      });
      decoded.push({ offset: packetOffset + 6, length: 2 }, { offset: packetOffset + 10, length: 2 });
      texture = { page: bytes.readUInt16LE(packetOffset + 10), clut: bytes.readUInt16LE(packetOffset + 6), uvs };
    }
    // Bound F3 renderer 800b1f6c uses normal lighting for 100/104/108/114.
    // Its 10c branch (800b2384) ignores the nominal normal and keeps RGB128.
    const lighting = flag === 1 ? 'none' : mode === 0x2c || mode === 0x2e
      ? 'neutral-color' : normalIndices.length === 1 ? 'single-normal' : 'vertex-normals';
    primitives.push({ index, vertexIndices, normalIndices, colors, textured, gouraud: (mode & 16) !== 0, lighting,
      lightingEnabled: (flag & 1) === 0, semiTransparent: (mode & 2) !== 0, rawTexture: textured && (mode & 1) !== 0, texture });
    packetOffset += packetBytes;
  }

  const spans = [
    { offset: targetOffset, length: 40 },
    { offset: vertexOffset, length: vertexCount * 8 },
    { offset: normalOffset, length: normalCount * 8 },
    { offset: primitiveOffset, length: packetOffset - primitiveOffset },
  ].filter(({ length }) => length > 0).sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < spans.length; index++) {
    if (spans[index].offset < spans[index - 1].offset + spans[index - 1].length) {
      fail('Battle TMD owned tables overlap.', { spans });
    }
  }
  const byteLength = Math.max(...spans.map(({ offset, length }) => offset + length)) - targetOffset;
  const coverage = new Uint8Array(byteLength).fill(2);
  for (const { offset, length } of decoded) coverage.fill(1, offset - targetOffset, offset - targetOffset + length);
  for (const { offset, length } of unresolved) coverage.fill(3, offset - targetOffset, offset - targetOffset + length);
  return {
    complete: diagnostics.length === 0,
    model: diagnostics.length === 0 ? {
      objectIndex: 0, verticesAlreadyShifted: (authoredScaleWord & 0x8000) !== 0, vertices, normals, primitives,
    } : null,
    diagnostics,
    consumption: {
      sourceOffset: targetOffset,
      byteLength,
      authoredScaleWord,
      decodedRanges: rangesFor(coverage, 1, targetOffset),
      consumerUnusedRanges: rangesFor(coverage, 2, targetOffset),
      unresolvedRanges: rangesFor(coverage, 3, targetOffset),
    },
  };
}
