import fs from 'node:fs';
import path from 'node:path';

import { BinaryReader, XenoFormatError, assertRange } from './binary-reader.js';
import { parseFieldModel } from './field-model.js';
import { normalizeFieldLevel } from './normalize.js';
import { parseSceneModelAnimations } from './scene-model-animation.js';
import { createSceneModelMeasurements, SCENE_MODEL_FIXED_POINT_ONE } from './scene-model-metrics.js';

export const SCENE_MODEL_COUNT = 72;

const VRAM_ROW_BYTES = 2048;
const VRAM_HEIGHT = 1024;
const TEXTURE_SIZE = 256;
const ABE_ALPHA = [128, 0, 0, 64];

function sceneFileName(index) {
  return `${index.toString().padStart(4, '0')}.bin`;
}

function validateModelNumber(modelNumber) {
  if (!Number.isInteger(modelNumber) || modelNumber < 1 || modelNumber > SCENE_MODEL_COUNT) {
    throw new RangeError(`Scene model number must be between 1 and ${SCENE_MODEL_COUNT}`);
  }
}

function validateDiscNumber(discNumber) {
  if (discNumber !== 1 && discNumber !== 2) {
    throw new RangeError('Disc number must be 1 or 2');
  }
}

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${label} must be a Buffer or Uint8Array.`);
}

export function getSceneModelResourcePaths(resourcesDir, modelNumber) {
  validateModelNumber(modelNumber);
  return {
    animationPath: path.join(resourcesDir, sceneFileName(modelNumber * 2 - 1)),
    modelPath: path.join(resourcesDir, sceneFileName(modelNumber * 2)),
  };
}

export function discoverSceneModelResources({ resourcesDir, discNumber = 1 }) {
  if (discNumber !== 1) return [];

  return Array.from({ length: SCENE_MODEL_COUNT }, (_, index) => {
    const modelNumber = index + 1;
    const { animationPath, modelPath } = getSceneModelResourcePaths(resourcesDir, modelNumber);
    const animationAvailable = fs.existsSync(animationPath);
    const modelAvailable = fs.existsSync(modelPath);

    return {
      discNumber,
      modelNumber,
      available: animationAvailable && modelAvailable,
      animationPath,
      modelPath,
      animationBytes: animationAvailable ? fs.statSync(animationPath).size : 0,
      modelBytes: modelAvailable ? fs.statSync(modelPath).size : 0,
    };
  });
}

function readSectionOffsets(reader, expectedCount) {
  const sectionCount = reader.u32(0);
  if (sectionCount !== expectedCount) {
    throw new XenoFormatError('Scene model has an unexpected section count', 'INVALID_SCENE_MODEL_SECTIONS', {
      expected: expectedCount,
      actual: sectionCount,
    });
  }

  const offsets = [];
  for (let index = 0; index <= sectionCount; index += 1) {
    offsets.push(reader.u32(4 + index * 4));
  }

  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] > reader.buffer.length || (index > 0 && offsets[index] < offsets[index - 1])) {
      throw new XenoFormatError('Scene model section offsets are invalid', 'INVALID_SCENE_MODEL_SECTIONS', {
        offsets,
        bytes: reader.buffer.length,
      });
    }
  }
  return offsets;
}

export function parseSceneModelConfig(sectionBuffer) {
  const reader = new BinaryReader(sectionBuffer, 'scene model configuration');
  const entryCount = reader.u32(0);
  if (entryCount < 1 || entryCount > 4096) {
    throw new XenoFormatError('Scene model configuration has an invalid entry count', 'INVALID_SCENE_MODEL_CONFIG', {
      entryCount,
    });
  }

  reader.check(4, (entryCount + 1) * 4);
  const entryOffsets = [];
  for (let index = 0; index <= entryCount; index += 1) {
    entryOffsets.push(reader.u32(4 + index * 4));
  }

  const tableBytes = 4 + (entryCount + 1) * 4;
  entryOffsets.forEach((offset, index) => {
    if (
      offset < tableBytes ||
      offset > sectionBuffer.length ||
      (index > 0 && offset < entryOffsets[index - 1])
    ) {
      throw new XenoFormatError('Scene model configuration offsets are invalid', 'INVALID_SCENE_MODEL_CONFIG', {
        entryOffsets,
        bytes: sectionBuffer.length,
      });
    }
  });

  const recordOffset = entryOffsets[0];
  const recordBytes = entryOffsets[1] - recordOffset;
  if (recordBytes < 0x14) {
    throw new XenoFormatError('Scene model configuration entry is truncated', 'INVALID_SCENE_MODEL_CONFIG', {
      recordBytes,
    });
  }
  reader.check(recordOffset, 0x14);

  const embeddedScale = reader.i16(recordOffset + 0x08);
  if (embeddedScale <= 0) {
    throw new XenoFormatError('Scene model configuration has an invalid embedded scale', 'INVALID_SCENE_MODEL_CONFIG', {
      embeddedScale,
    });
  }

  return {
    entryCount,
    entryOffsets,
    firstEntryBytes: recordBytes,
    unknown0: reader.i16(recordOffset),
    rawDimensions: [
      reader.i16(recordOffset + 0x02),
      reader.i16(recordOffset + 0x04),
      reader.i16(recordOffset + 0x06),
    ],
    embeddedScale,
    embeddedScaleFactor: embeddedScale / SCENE_MODEL_FIXED_POINT_ONE,
    byteA: reader.u8(recordOffset + 0x0a),
    flags: reader.u16(recordOffset + 0x0c),
    byteE: reader.u8(recordOffset + 0x0e),
    byte10: reader.u8(recordOffset + 0x10),
    byte12: reader.u8(recordOffset + 0x12),
  };
}

function wrapGenericModel(modelData) {
  const wrapped = Buffer.allocUnsafe(modelData.length + 8);
  wrapped.writeUInt32LE(1, 0);
  wrapped.writeUInt32LE(8, 4);
  modelData.copy(wrapped, 8);
  return wrapped;
}

function parseGeometry(modelBuffer, offsets) {
  const genericModel = modelBuffer.subarray(offsets[1], offsets[2]);
  const parsed = parseFieldModel(wrapGenericModel(genericModel));
  const blocks = parsed.parts[0]?.blocks || [];

  return {
    ...parsed,
    parts: blocks.map((block) => ({ blocks: [block] })),
  };
}

function colorFromPsx(value, semiTransparent, alpha) {
  const stp = (value & 0x8000) !== 0;
  const red = Math.floor((((value & 31) * 255) + 15) / 31);
  const green = Math.floor(((((value >> 5) & 31) * 255) + 15) / 31);
  const blue = Math.floor(((((value >> 10) & 31) * 255) + 15) / 31);
  let outputAlpha;

  if ((value & 0x7fff) === 0) {
    outputAlpha = stp ? 255 : 0;
  } else if (stp && semiTransparent) {
    outputAlpha = alpha;
  } else {
    outputAlpha = 255;
  }

  return [red, green, blue, outputAlpha];
}

function writePixel(output, pixelIndex, color) {
  const offset = pixelIndex * 4;
  output[offset] = color[0];
  output[offset + 1] = color[1];
  output[offset + 2] = color[2];
  output[offset + 3] = color[3];
}

function readVramColor(vram, offset) {
  if (offset < 0 || offset + 2 > vram.length) {
    throw new XenoFormatError('Scene texture lookup is outside PlayStation VRAM', 'INVALID_VRAM_ADDRESS', {
      offset,
    });
  }
  return vram[offset] | (vram[offset + 1] << 8);
}

function unpackSceneTextureVram(reader, textureOffset) {
  const vram = Buffer.alloc(VRAM_ROW_BYTES * VRAM_HEIGHT);
  const textureCount = reader.u32(textureOffset);
  if (textureCount > 4096) {
    throw new XenoFormatError('Scene model has an unreasonable texture upload count', 'INVALID_TEXTURE_COUNT', {
      textureCount,
    });
  }

  reader.check(textureOffset + 4, textureCount * 4);
  for (let textureIndex = 0; textureIndex < textureCount; textureIndex += 1) {
    const headerOffset = textureOffset + reader.u32(textureOffset + 4 + textureIndex * 4);
    reader.check(headerOffset, 16);
    const positionX = reader.u16(headerOffset + 4);
    const positionY = reader.u16(headerOffset + 6);
    const moveX = reader.u16(headerOffset + 8);
    const moveY = reader.u16(headerOffset + 10);
    const width = reader.u16(headerOffset + 12);
    const height = reader.u16(headerOffset + 14);
    const rowBytes = width * 2;
    const sourceOffset = headerOffset + 16;
    const destinationX = positionX + moveX;
    const destinationY = positionY + moveY;

    assertRange(reader.buffer, sourceOffset, rowBytes * height, 'scene texture upload');
    if (destinationX + width > VRAM_ROW_BYTES / 2 || destinationY + height > VRAM_HEIGHT) {
      throw new XenoFormatError('Scene texture upload is outside PlayStation VRAM', 'INVALID_VRAM_UPLOAD', {
        textureIndex,
        destinationX,
        destinationY,
        width,
        height,
      });
    }

    for (let row = 0; row < height; row += 1) {
      const from = sourceOffset + row * rowBytes;
      const to = (destinationY + row) * VRAM_ROW_BYTES + destinationX * 2;
      reader.buffer.copy(vram, to, from, from + rowBytes);
    }
  }
  return vram;
}

function decodeTextures(modelBuffer, textureOffset, materials) {
  const reader = new BinaryReader(modelBuffer, 'scene model textures');
  const vram = unpackSceneTextureVram(reader, textureOffset);

  return materials.map((material, materialIndex) => {
    if (!material.textured) {
      return null;
    }

    const { status, clut, semiTransparent } = material;
    const textureX = (status & 0x0f) * 64 * 2;
    const textureY = ((status >> 4) & 1) * 256;
    const textureMode = (status >> 7) & 3;
    const paletteX = (clut & 63) * 16;
    const paletteY = clut >> 6;
    const alpha = semiTransparent ? ABE_ALPHA[(status >> 5) & 3] : 0;
    const rgba = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);

    if (textureMode === 0 || textureMode === 1) {
      const paletteSize = textureMode === 0 ? 16 : 256;
      const palette = new Array(paletteSize);
      for (let paletteIndex = 0; paletteIndex < paletteSize; paletteIndex += 1) {
        const address = paletteY * VRAM_ROW_BYTES + (paletteX + paletteIndex) * 2;
        palette[paletteIndex] = colorFromPsx(readVramColor(vram, address), semiTransparent, alpha);
      }

      for (let y = 0; y < TEXTURE_SIZE; y += 1) {
        for (let x = 0; x < TEXTURE_SIZE; x += 1) {
          const address = (y + textureY) * VRAM_ROW_BYTES + textureX;
          const paletteIndex = textureMode === 0
            ? ((x & 1) === 0 ? vram[address + Math.floor(x / 2)] & 0x0f : vram[address + Math.floor(x / 2)] >> 4)
            : vram[address + x];
          writePixel(rgba, y * TEXTURE_SIZE + x, palette[paletteIndex]);
        }
      }
    } else {
      // The retail renderer samples both PSX texture-depth values 2 and 3 as
      // direct 16-bit color. Enemy visual set 52 contains the mode-3 case.
      for (let y = 0; y < TEXTURE_SIZE; y += 1) {
        for (let x = 0; x < TEXTURE_SIZE; x += 1) {
          const address = (y + textureY) * VRAM_ROW_BYTES + textureX + x * 2;
          writePixel(rgba, y * TEXTURE_SIZE + x, colorFromPsx(
            readVramColor(vram, address),
            semiTransparent,
            alpha,
          ));
        }
      }
    }

    return { width: TEXTURE_SIZE, height: TEXTURE_SIZE, rgba };
  });
}

function parseHierarchy(reader, hierarchyOffset, hierarchyEnd, partCount) {
  const nodes = [];
  let offset = hierarchyOffset;

  while (offset + 4 <= hierarchyEnd) {
    const part = reader.i16(offset);
    const parent = reader.i16(offset + 2);
    offset += 4;
    if (part === -2) {
      break;
    }
    if (part < -1 || part >= partCount) {
      throw new XenoFormatError('Scene hierarchy references a missing model part', 'INVALID_SCENE_MODEL_PART', {
        nodeIndex: nodes.length,
        part,
        partCount,
      });
    }
    nodes.push({ part, parent });
  }

  if (nodes.length === 0 || offset > hierarchyEnd || reader.i16(offset - 4) !== -2) {
    throw new XenoFormatError('Scene hierarchy terminator was not found', 'INVALID_SCENE_HIERARCHY');
  }

  nodes.forEach((node, nodeIndex) => {
    if (node.parent < -1 || node.parent >= nodes.length || node.parent === nodeIndex) {
      throw new XenoFormatError('Scene hierarchy has an invalid parent', 'INVALID_SCENE_PARENT', {
        nodeIndex,
        parent: node.parent,
      });
    }
  });

  return nodes;
}

// Returns the same parts/materials/textures/nodes/stats shape as loadFieldLevel.
// Scene-model nodes additionally retain their parent index for articulated GLB output.
export function decodeSceneModel({
  animationBuffer,
  modelBuffer,
  discNumber,
  modelNumber,
  runtimeContext = null,
  onProgress = () => {},
}) {
  validateDiscNumber(discNumber);
  validateModelNumber(modelNumber);
  if (typeof onProgress !== 'function') {
    throw new TypeError('Scene model progress callback must be a function.');
  }

  const animation = asBuffer(animationBuffer, 'Scene model animation data');
  const model = asBuffer(modelBuffer, 'Scene model data');
  const modelReader = new BinaryReader(model, 'scene model');
  const offsets = readSectionOffsets(modelReader, 4);
  const modelConfig = parseSceneModelConfig(model.subarray(offsets[3], offsets[4]));
  const measurements = createSceneModelMeasurements(modelConfig);

  onProgress({ phase: 'geometry', completed: 2, total: 6, message: 'Parsing scene geometry' });
  const parsedModel = parseGeometry(model, offsets);
  onProgress({ phase: 'textures', completed: 3, total: 6, message: 'Decoding scene textures' });
  const textures = decodeTextures(model, offsets[0], parsedModel.materials);
  onProgress({ phase: 'hierarchy', completed: 4, total: 6, message: 'Parsing scene hierarchy' });
  const hierarchy = parseHierarchy(modelReader, offsets[2], offsets[3], parsedModel.parts.length);
  onProgress({ phase: 'pose', completed: 5, total: 6, message: 'Decoding scene-model animations' });
  const animationData = parseSceneModelAnimations(animation, hierarchy, {
    modelScale: modelConfig.embeddedScale,
    runtimeContext,
  });
  const nodes = hierarchy.map((node, nodeIndex) => ({
    ...node,
    flags: node.part < 0 ? 480 : 0,
    rotation: animationData.defaultPose.rotations[nodeIndex],
    translation: animationData.defaultPose.translations[nodeIndex],
  }));
  onProgress({ phase: 'normalize', completed: 6, total: 6, message: 'Normalizing scene model geometry' });

  const scene = normalizeFieldLevel({
    discNumber,
    levelNumber: modelNumber,
    parsedModel,
    textures,
    nodes,
  });

  return {
    ...scene,
    assetType: 'scene-model',
    sceneModelNumber: modelNumber,
    modelConfig,
    measurements,
    nodes,
    animations: animationData.clips,
    animationStats: {
      fps: animationData.fps,
      keyframes: animationData.keyframeCount,
      clips: animationData.scriptCount,
      completeClips: animationData.clips.filter((clip) => clip.complete).length,
    },
  };
}

export function loadSceneModel({
  resourcesDir,
  discNumber = 1,
  modelNumber,
  runtimeContext = null,
  onProgress = () => {},
}) {
  validateDiscNumber(discNumber);
  validateModelNumber(modelNumber);
  if (discNumber !== 1) {
    throw new XenoFormatError('Only Disc 1 scene models are mapped in this version', 'DISC_NOT_SUPPORTED', {
      discNumber,
    });
  }

  const { animationPath, modelPath } = getSceneModelResourcePaths(resourcesDir, modelNumber);
  if (!fs.existsSync(animationPath) || !fs.existsSync(modelPath)) {
    throw new XenoFormatError('Scene model resources have not been extracted', 'SCENE_MODEL_RESOURCES_MISSING', {
      discNumber,
      modelNumber,
      animationPath,
      modelPath,
    });
  }

  onProgress({ phase: 'read', completed: 1, total: 6, message: 'Reading scene model files' });
  return decodeSceneModel({
    animationBuffer: fs.readFileSync(animationPath),
    modelBuffer: fs.readFileSync(modelPath),
    discNumber,
    modelNumber,
    runtimeContext,
    onProgress,
  });
}
