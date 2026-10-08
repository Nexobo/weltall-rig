import crypto from 'node:crypto';

import { canonicalJson, validateCleanContentValue } from '../../../shared/content/content-schema.js';
import { decompressLzsFile } from '../xeno/lzs.js';
import { assertSourceContext } from './source-input.js';

export const BATTLE_POLYGON_SHATTER_CONTRACT_DECODER = Object.freeze({ id: 'battle-polygon-shatter-contract', revision: 1 });

const SHATTER_SHA = '8c303aab8a88012d916e8d033f2e4cda36f388ecbb3d684a8d4729c1af3a78a3';
const BATTLE_SHA = 'b9c3a15bf5f3eb06bcb3824ef62793b9a500fe1dcb3717fe8963e23e9f27628b';
const BATTLE_IMAGE_SHA = '1830b4ef1fe37129972fc310dfad534f8161d6c0b123e74254c3711334a3e291';
const EXE_SHA = {
  1: 'dc0b2dd786203d4cce5927c5a3fc85a18f39a3f7406078860076ebb0bbae7119',
  2: '3246e15f4040305b280adae06bc7bb908ee882794183bec9fc23e71d85c19c35',
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CONTRACT_SHA = Object.freeze({
  1: '8c7ecbfd26c1c3b5cf52ae2535ce0442f1571e8bc50d0c155fb69ff9a1711b63',
  2: 'b55630868c4af10eae871bff18a0f173364968c20451868c6397f28e2c4f841e',
});

/** Bind the complete decoded behavior and fixed module source, not claimed source hashes alone. */
export function assertBattlePolygonShatterContract(contract) {
  if (!contract || ![1, 2].includes(contract.discNumber)
    || sha256(canonicalJson(contract)) !== CONTRACT_SHA[contract.discNumber]) {
    throw new TypeError('Polygon shatter requires its authenticated complete retail behavior contract.');
  }
}

function authenticated(value, context, expected) {
  assertSourceContext(value, context);
  if (context.storageLayout !== 'ordinary' || value.byteLength !== expected.bytes
    || context.sha256 !== expected.sha256 || context.flatIndex !== expected.flatIndex
    || context.directoryOrdinal !== expected.directoryOrdinal || context.fileIndex !== expected.fileIndex) {
    throw new TypeError('Polygon shatter contract requires its authenticated retail source occurrences.');
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Decode the six authored bytes with the retail wrapper's overlapping bit fields. */
export function deriveBattlePolygonShatterParameters(value, motionScale) {
  const bytes = Array.from(value ?? []);
  if (bytes.length !== 6 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
    || !Number.isInteger(motionScale) || motionScale < 0 || motionScale > 65535) {
    throw new TypeError('Polygon shatter parameters require six bytes and an unsigned 16-bit motion scale.');
  }
  const gravityBase = ((bytes[1] << 24 >> 24) << 3) | bytes[0];
  const scaled = value => Math.trunc(Math.imul(value, motionScale) / 1024);
  return {
    gravity: motionScale === 0 ? gravityBase << 5 : scaled(gravityBase) << 8,
    baseSpeed: motionScale === 0 ? bytes[2] << 13 : scaled(bytes[2]) << 16,
    speedSpread: motionScale === 0 ? bytes[3] << 13 : scaled(bytes[3]) << 16,
    spinSpread: bytes[4] << 4,
    lifetimeUpdates: bytes[5] << 2,
  };
}

/** Extract clean effect behavior and numeric tables; native addresses stay in evidence. */
export function decodeBattlePolygonShatterContract({
  overlayBytes, overlayContext, battleBytes, battleContext, executableBytes, executableContext,
}) {
  const discNumber = overlayContext?.discNumber;
  if (![1, 2].includes(discNumber) || battleContext?.discNumber !== discNumber || executableContext?.discNumber !== discNumber) {
    throw new TypeError('Polygon shatter sources must belong to one retail disc.');
  }
  const overlay = authenticated(overlayBytes, overlayContext, {
    bytes: 3612, sha256: SHATTER_SHA, flatIndex: discNumber === 1 ? 3384 : 3379, directoryOrdinal: 22, fileIndex: 3,
  });
  const battle = authenticated(battleBytes, battleContext, {
    bytes: 166564, sha256: BATTLE_SHA, flatIndex: discNumber === 1 ? 38 : 33, directoryOrdinal: 3, fileIndex: 3,
  });
  assertSourceContext(executableBytes, executableContext);
  if (executableContext.storageLayout !== 'ordinary' || executableBytes.byteLength !== 303104
    || executableContext.sha256 !== EXE_SHA[discNumber] || executableContext.flatIndex !== (discNumber === 1 ? 22 : 17)
    || executableContext.directoryOrdinal !== 0 || executableContext.fileIndex !== 4) {
    throw new TypeError('Polygon shatter requires the authenticated resident executable.');
  }
  const executable = Buffer.from(executableBytes.buffer, executableBytes.byteOffset, executableBytes.byteLength);
  const image = decompressLzsFile(battle);
  if (image.length !== 343936 || sha256(image) !== BATTLE_IMAGE_SHA) throw new Error('Polygon shatter Battle image failed authentication.');
  const readTable = (address, count, stride = 2) => Array.from({ length: count }, (_, i) => executable.readInt16LE(address - 0x8000f800 + i * stride));
  const sineQuarter = readTable(0x800523f0, 1025, 4);
  const sine = angle => {
    const a = angle & 4095;
    return a <= 1024 ? sineQuarter[a] : a <= 2048 ? sineQuarter[2048 - a]
      : a <= 3072 ? -sineQuarter[a - 2048] : -sineQuarter[4096 - a];
  };
  for (let angle = 0; angle < 4096; angle += 1) {
    const offset = 0x800523f0 - 0x8000f800 + angle * 4;
    if (executable.readInt16LE(offset) !== sine(angle) || executable.readInt16LE(offset + 2) !== sine(angle + 1024)) {
      throw new Error('Polygon shatter trigonometric table does not have the authenticated quarter-wave symmetry.');
    }
  }
  const range = (bytes, context, base, start, end) => ({
    sourceId: context.sourceId, startAddress: start, offset: start - base, length: end - start,
    sha256: sha256(bytes.subarray(start - base, end - base)),
  });
  const source = context => ({ id: context.sourceId, bytes: context.logicalBytes, sha256: context.sha256 });
  const contract = {
    schema: { name: 'xenogears-battle-polygon-shatter-contract', version: 1 },
    decoder: { ...BATTLE_POLYGON_SHATTER_CONTRACT_DECODER },
    discNumber,
    complete: true,
    sources: { overlay: source(overlayContext), battle: source(battleContext), executable: source(executableContext) },
    playback: {
      operation: 'shatter-selected-model-polygons',
      requiredContexts: ['selected-tmd-object-and-current-vertices', 'current-model-material-packets', 'current-model-transform', 'sprite-motion-scale', 'shared-random-state', 'current-battle-camera-and-ordering-table'],
      parameters: {
        input: 'decoded-data-reference',
        fields: ['gravityBase', 'baseSpeed', 'speedSpread', 'spinSpread', 'lifetimeUpdates'],
        motionScaleZero: { gravity: 'gravityBase << 5', baseSpeed: 'baseSpeed << 13', speedSpread: 'speedSpread << 13' },
        motionScaleNonzero: {
          scale: 'trunc(int32(value * motionScale) / 1024)',
          gravity: 'scale(gravityBase) << 8', baseSpeed: 'scale(baseSpeed) << 16', speedSpread: 'scale(speedSpread) << 16',
        },
        spinSpread: 'spinSpread',
        lifetimeUpdates: 'lifetimeUpdates',
      },
      ownership: {
        selectedObjectIndex: 0,
        capturesModelTransformAtCreation: true,
        usesCurrentVerticesAfterPriorModelMutations: true,
        appliesAuthoredScaleHeaderExponent: false,
        transfersExistingMaterialPackets: true,
        transferredMaterialState: 'retain-current-colors-uvs-texture-page-clut-blend-and-raw-texture-state',
        whenMaterialPacketsAbsent: { constructFromSelectedModel: true, preserveAuthoredBlend: true, rawTexture: true },
        clearsActorSelectedModelAndMaterialPacketReferences: true,
        cleanup: ['release-fragments', 'release-owned-material-packets', 'unregister-update-and-draw', 'release-effect-instance'],
        freesSourceModelBytes: false,
      },
      fragments: {
        count: 'selected-object-primitive-count',
        order: 'original-primitive-order',
        vertices: 'primitive.vertexIndices-in-current-model-vertex-table',
        centroid: 'trunc(signed16(sum-of-each-axis) / polygonVertexCount)',
        localVertex: 'signed16(vertex - centroid)',
        triangleFourthStorageVertex: 'repeat-third-vertex',
        initialTranslation: 'signed32(centroid << 16)',
        initialRotation: [0, 0, 0],
        rotationUnitsPerTurn: 4096,
        random: {
          state: 'shared-unsigned-32-bit-state',
          nextState: 'unsigned32(state * 1103515245 + 12345)',
          result: '(nextState >>> 16) & 32767',
          usedBits: 'result & 255',
          drawsPerFragment: ['speed', 'spin-x', 'spin-y', 'spin-z'],
          speed: 'signed32(baseSpeed + trunc(signed32(randomByte * speedSpread) / 256))',
          spin: 'signed16(q - trunc(q / 2)), where q = trunc(signed32(randomByte * spinSpread) / 256)',
        },
        direction: {
          origin: [0, 0, 0],
          horizontalDistance: 'squareRootTableLookup(centroidX * centroidX + centroidZ * centroidZ)',
          angles: ['0', 'atanTableLookup(centroidZ, centroidX)', 'atanTableLookup(centroidY, horizontalDistance)'],
          velocity: 'applyLongVector(rotationMatrix(angles), [speed, 0, 0])',
          replacesWithNormalizedCentroid: false,
        },
      },
      update: {
        clock: 'battle-effect-update',
        orderedSteps: ['translation = signed32(translation + velocity)', 'rotation = unsigned16(rotation + spin)', 'velocityY = signed32(velocityY + gravity)', 'remainingLifetime -= 1', 'delete-if-remainingLifetime < 0'],
        deletionUpdate: 'lifetimeUpdates + 1',
        integratesOnDeletionUpdate: true,
      },
      draw: {
        transform: 'currentCamera * capturedModelTransform * fragmentTransform',
        fragmentTranslation: 'signed16(translationQ16 >> 16)',
        fragmentRotation: 'rotationMatrix(fragmentRotationAngles)',
        geometry: 'centroid-relative-original-triangle-or-quad',
        projection: 'current-camera-perspective-project-each-vertex',
        preservesTransferredMaterialState: true,
        recomputesLighting: false,
        testsProjectionFlagsOrDepth: false,
        submission: 'prepend-each-primitive-to-current-battle-ordering-table-head-in-original-primitive-order',
        packetBuffers: 'alternate-current-render-buffer',
      },
      arithmetic: {
        integerOverflow: 'signed32-or-signed16-at-each-indicated-storage-operation',
        q12Product: 'signed32(left * right) >> 12',
        sineQuarter,
        sine: 'quarter-wave-reflection-and-sign-with-angle-masked-to4095',
        cosine: 'sine(angle + 1024)',
        atanRatioTable: readTable(0x80057030, 1025),
        atan: {
          zeroVector: 0,
          ratio: 'floor(1024 * min(abs(y),abs(x)) / max(abs(y),abs(x)))',
          firstQuadrant: 'abs(y) < abs(x) ? table[ratio] : 1024 - table[ratio]',
          signX: 'x < 0 ? 2048 - firstQuadrant : firstQuadrant',
          signY: 'y < 0 ? -angleAfterSignX : angleAfterSignX',
          inputDomain: 'centroid-components-and-horizontal-distance',
        },
        squareRootTable: readTable(0x80056a00, 192),
        squareRoot: {
          zero: 0,
          leadingZeroPairs: 'clz32(value) & ~1',
          normalized: 'leadingZeroPairs >= 24 ? value << (leadingZeroPairs - 24) : value >> (24 - leadingZeroPairs)',
          result: '(table[normalized - 64] << ((31 - leadingZeroPairs) >> 1)) >>> 12',
        },
        rotationMatrix: {
          names: 'sx,cx,sy,cy,sz,cz are signed Q12 sine/cosine of x,y,z; mul is q12Product',
          temporary: ['negSyCz = mul(cz,-sy)', 'negSySz = mul(sz,-sy)'],
          rows: [
            ['mul(cz,cy)', 'mul(-sz,cy)', 'sy'],
            ['mul(sz,cx)-mul(negSyCz,sx)', 'mul(cz,cx)+mul(negSySz,sx)', 'mul(-cy,sx)'],
            ['mul(negSyCz,cx)+mul(sz,sx)', 'mul(cz,sx)-mul(negSySz,cx)', 'mul(cy,cx)'],
          ],
          storedCoefficient: 'signed16',
        },
        applyLongVector: {
          high: 'trunc(component / 32768)',
          low: 'component - high * 32768',
          matrixInputHigh: 'signed16(high)',
          matrixInputLow: 'signed16(low)',
          rowResult: 'signed32((dot(matrixRow, matrixInputHigh) << 3) + (dot(matrixRow, matrixInputLow) >> 12))',
        },
      },
    },
    evidence: {
      parameterDecode: {
        byteCount: 6,
        reference: 'signed-16-bit-displacement-relative-to-the-effect-operand',
        fields: { gravityBase: '(signed8(byte1) << 3) | byte0', baseSpeed: 'byte2', speedSpread: 'byte3', spinSpread: 'byte4 << 4', lifetimeUpdates: 'byte5 << 2' },
      },
      shatter: [range(overlay, overlayContext, 0x801fc000, 0x801fc000, 0x801fce1c)],
      battleImageSha256: BATTLE_IMAGE_SHA,
      battle: [range(image, battleContext, 0x8006faf0, 0x800b6a7c, 0x800b6b98), range(image, battleContext, 0x8006faf0, 0x800c0828, 0x800c08cc)],
      executable: [
        [0x80022cac, 0x80022cdc], [0x8003fa38, 0x8003fa78], [0x8003f738, 0x8003f8b0],
        [0x8004947c, 0x800495dc], [0x80048c4c, 0x80048cd0], [0x8004b32c, 0x8004b4ac],
        [0x800523f0, 0x800563f0], [0x80056a00, 0x80056b80], [0x80057030, 0x80057832],
      ].map(([start, end]) => range(executable, executableContext, 0x8000f800, start, end)),
    },
    diagnostics: [],
  };
  validateCleanContentValue(contract, 'Battle polygon shatter contract');
  return contract;
}
