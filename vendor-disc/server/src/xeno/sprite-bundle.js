import { BinaryReader, XenoFormatError } from './binary-reader.js';
import { parseSpriteAnimations } from './sprite-animation.js';
import { parseSpriteFrames } from './sprite-frame.js';

const MAX_BUNDLE_ENTRIES = 64;
const MAX_BATTLE_SPRITES = 1024;
const MAX_LZS_TAIL_PADDING = 16;

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function u24(buffer, offset) {
  if (offset < 0 || offset + 3 > buffer.length) {
    throw new XenoFormatError('24-bit offset is outside sprite resource', 'TRUNCATED_SPRITE_RESOURCE', {
      offset,
      bufferLength: buffer.length,
    });
  }
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function plausibleBundleAt(buffer, offset) {
  if (offset < 0 || offset + 20 > buffer.length) return false;
  const entryCount = buffer.readUInt32LE(offset);
  if (entryCount < 3 || entryCount > MAX_BUNDLE_ENTRIES) return false;
  const tableEnd = offset + 4 + (entryCount + 1) * 4;
  if (tableEnd > buffer.length) return false;
  let previous = 4 + (entryCount + 1) * 4;
  for (let index = 0; index <= entryCount; index += 1) {
    const entryOffset = buffer.readUInt32LE(offset + 4 + index * 4);
    if (entryOffset < previous || offset + entryOffset > buffer.length) return false;
    previous = entryOffset;
  }
  return true;
}

function decompressSpriteLzs(buffer) {
  const reader = new BinaryReader(buffer, 'sprite LZS file');
  const outputSize = reader.u32(0);
  const source = reader.slice(4, buffer.length - 4);
  const output = Buffer.alloc(outputSize);
  let inputOffset = 0;
  let outputOffset = 0;
  let command = 0;
  let bitsRemaining = 0;

  while (outputOffset < outputSize) {
    if (bitsRemaining === 0) {
      if (inputOffset >= source.length) break;
      command = source[inputOffset++];
      bitsRemaining = 8;
    }

    if ((command & 1) !== 0) {
      if (inputOffset + 2 > source.length) break;
      const a = source[inputOffset++];
      const b = source[inputOffset++];
      const distance = a | ((b & 0x0f) << 8);
      const length = (b >> 4) + 3;
      let readOffset = outputOffset - distance;
      for (let index = 0; index < length && outputOffset < outputSize; index += 1) {
        output[outputOffset++] = readOffset < 0 ? 0 : output[readOffset];
        readOffset += 1;
      }
    } else {
      if (inputOffset >= source.length) break;
      output[outputOffset++] = source[inputOffset++];
    }
    command >>= 1;
    bitsRemaining -= 1;
  }

  const missingBytes = outputSize - outputOffset;
  if (missingBytes > MAX_LZS_TAIL_PADDING) {
    throw new XenoFormatError('Sprite LZS stream ended before its declared output size', 'TRUNCATED_SPRITE_LZS', {
      outputSize,
      decodedSize: outputOffset,
      missingBytes,
    });
  }

  return {
    buffer: output,
    diagnostics: missingBytes === 0 ? [] : [diagnostic(
      'LZS_TAIL_PADDED',
      'Sprite LZS stream omits trailing alignment bytes; they were restored as zero padding',
      { outputSize, decodedSize: outputOffset, missingBytes },
    )],
  };
}

export function decodePsxSpriteColor(value, colorIndex = 1) {
  const red = Math.floor((((value & 31) * 255) + 15) / 31);
  const green = Math.floor(((((value >> 5) & 31) * 255) + 15) / 31);
  const blue = Math.floor(((((value >> 10) & 31) * 255) + 15) / 31);
  const semiTransparent = (value & 0x8000) !== 0;
  return {
    value,
    red,
    green,
    blue,
    alpha: colorIndex === 0 ? 0 : 255,
    semiTransparent,
  };
}

export function parseSpritePalettes(paletteBuffer) {
  const buffer = Buffer.isBuffer(paletteBuffer) ? paletteBuffer : Buffer.from(paletteBuffer);
  const reader = new BinaryReader(buffer, 'sprite palette data');
  reader.check(0, 4);
  const widthUnits = reader.u16(0);
  const unknown = reader.u16(2);
  const availableColors = Math.floor((buffer.length - 4) / 2);
  const declaredColors = widthUnits * 16;
  const colorCount = declaredColors > 0 ? Math.min(declaredColors, availableColors) : availableColors;
  const diagnostics = [];

  if (declaredColors > availableColors) {
    diagnostics.push(diagnostic('TRUNCATED_PALETTE', 'Sprite palette contains fewer colors than its header declares', {
      declaredColors,
      availableColors,
    }));
  }
  if ((buffer.length - 4) % 2 !== 0) {
    diagnostics.push(diagnostic('ODD_PALETTE_LENGTH', 'Sprite palette has one trailing byte', {
      paletteLength: buffer.length,
    }));
  }

  const palettes = [];
  for (let paletteIndex = 0; paletteIndex < Math.ceil(colorCount / 16); paletteIndex += 1) {
    const colors = [];
    for (let colorIndex = 0; colorIndex < 16 && paletteIndex * 16 + colorIndex < colorCount; colorIndex += 1) {
      const value = reader.u16(4 + (paletteIndex * 16 + colorIndex) * 2);
      const color = decodePsxSpriteColor(value, colorIndex);
      colors.push(color);
    }
    palettes.push({ index: paletteIndex, colors });
  }

  return { widthUnits, unknown, colorCount, palettes, diagnostics };
}

export function parseBattleTexturePages(resourceBuffer, textureOffset) {
  const buffer = Buffer.isBuffer(resourceBuffer) ? resourceBuffer : Buffer.from(resourceBuffer);
  const pageCount = u24(buffer, textureOffset);
  if (pageCount > 256 || textureOffset + 4 + pageCount * 4 > buffer.length) {
    throw new XenoFormatError('Invalid battle sprite texture page table', 'INVALID_SPRITE_TEXTURE_TABLE', {
      textureOffset,
      pageCount,
      resourceLength: buffer.length,
    });
  }

  const pages = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const relativeOffset = u24(buffer, textureOffset + 4 + pageIndex * 4);
    const pageOffset = textureOffset + relativeOffset;
    if (pageOffset + 4 > buffer.length) {
      throw new XenoFormatError('Battle sprite texture page points outside the resource', 'INVALID_SPRITE_TEXTURE_OFFSET', {
        textureOffset,
        pageIndex,
        pageOffset,
      });
    }
    const widthWords = buffer.readUInt16LE(pageOffset);
    const height = buffer.readUInt16LE(pageOffset + 2);
    const byteCount = widthWords * height * 2;
    if (pageOffset + 4 + byteCount > buffer.length) {
      throw new XenoFormatError('Battle sprite texture page is truncated', 'TRUNCATED_SPRITE_TEXTURE', {
        pageIndex,
        pageOffset,
        widthWords,
        height,
      });
    }
    const packed = buffer.subarray(pageOffset + 4, pageOffset + 4 + byteCount);
    const pixels = new Uint8Array(byteCount * 2);
    for (let pixelIndex = 0; pixelIndex < pixels.length; pixelIndex += 1) {
      const value = packed[pixelIndex >> 1];
      pixels[pixelIndex] = (pixelIndex & 1) === 0 ? value & 0x0f : value >> 4;
    }
    pages.push({ index: pageIndex, width: widthWords * 4, height, pixels });
  }
  return pages;
}

export function parseSpriteBundle(
  bundleBuffer,
  { texturePages = null, vram = null, composeFrames = true } = {},
) {
  const buffer = Buffer.isBuffer(bundleBuffer) ? bundleBuffer : Buffer.from(bundleBuffer);
  const reader = new BinaryReader(buffer, 'sprite bundle');
  const entryCount = reader.u32(0);
  if (entryCount < 3 || entryCount > MAX_BUNDLE_ENTRIES) {
    throw new XenoFormatError('Sprite bundle must contain at least three entries', 'INVALID_SPRITE_ENTRY_COUNT', {
      entryCount,
      bundleLength: buffer.length,
    });
  }
  reader.check(4, (entryCount + 1) * 4);

  const entryOffsets = [];
  let previousOffset = 4 + (entryCount + 1) * 4;
  for (let index = 0; index <= entryCount; index += 1) {
    const offset = reader.u32(4 + index * 4);
    if (offset < previousOffset || offset > buffer.length) {
      throw new XenoFormatError('Sprite bundle entry offsets are invalid', 'INVALID_SPRITE_ENTRY_OFFSETS', {
        index,
        offset,
        previousOffset,
        bundleLength: buffer.length,
      });
    }
    entryOffsets.push(offset);
    previousOffset = offset;
  }

  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    entries.push(buffer.subarray(entryOffsets[index], entryOffsets[index + 1]));
  }
  const animationSet = parseSpriteAnimations(entries[0]);
  const paletteSet = parseSpritePalettes(entries[2]);
  const frameSet = parseSpriteFrames(entries[1], {
    palettes: paletteSet.palettes,
    texturePages,
    vram,
    compose: composeFrames,
  });

  return {
    buffer,
    entryCount,
    entryOffsets,
    entries,
    animationSet,
    frameSet,
    palettes: paletteSet.palettes,
    paletteSet,
    texturePages,
    vram,
    diagnostics: [
      ...animationSet.diagnostics,
      ...paletteSet.diagnostics,
      ...frameSet.diagnostics,
    ],
  };
}

export function parseSpriteResource(
  resourceBuffer,
  { composeFrames = true, texturePages = null, vram = null } = {},
) {
  const original = Buffer.isBuffer(resourceBuffer) ? resourceBuffer : Buffer.from(resourceBuffer);
  let buffer = original;
  let format = 'bundle';
  const diagnostics = [];

  if (!plausibleBundleAt(buffer, 0)) {
    const declaredOutputSize = buffer.length >= 4 ? buffer.readUInt32LE(0) : 0;
    if (declaredOutputSize > 0 && declaredOutputSize <= 16 * 1024 * 1024) {
      const decoded = decompressSpriteLzs(buffer);
      if (plausibleBundleAt(decoded.buffer, 0)) {
        buffer = decoded.buffer;
        format = 'lzs-bundle';
        diagnostics.push(...decoded.diagnostics);
      }
    }
  }

  if (plausibleBundleAt(buffer, 0)) {
    const bundle = parseSpriteBundle(buffer, { composeFrames, texturePages, vram });
    return { format, bundles: [bundle], diagnostics: [...diagnostics, ...bundle.diagnostics] };
  }

  const spriteCount = u24(original, 0);
  const firstTextureOffset = u24(original, 4);
  if (spriteCount < 1 || spriteCount > MAX_BATTLE_SPRITES || 8 + spriteCount * 12 > original.length) {
    throw new XenoFormatError('Resource is not a recognized Xenogears sprite container', 'INVALID_SPRITE_RESOURCE', {
      resourceLength: original.length,
      spriteCount,
    });
  }

  format = 'battle-set';
  const bundles = [];
  for (let index = 0; index < spriteCount; index += 1) {
    const tableOffset = 8 + index * 12;
    const bundleOffset = u24(original, tableOffset);
    const textureOffset = u24(original, tableOffset + 4);
    if (textureOffset < firstTextureOffset || !plausibleBundleAt(original, bundleOffset)) {
      diagnostics.push(diagnostic(
        'SKIPPED_BATTLE_SPRITE_ENTRY',
        'Battle resource table entry does not reference a 2D sprite bundle',
        { index, bundleOffset, textureOffset },
      ));
      continue;
    }

    const texturePages = parseBattleTexturePages(original, textureOffset);
    const bundleLength = original.readUInt32LE(bundleOffset + 4 + original.readUInt32LE(bundleOffset) * 4);
    const bundle = parseSpriteBundle(original.subarray(bundleOffset, bundleOffset + bundleLength), {
      texturePages,
      composeFrames,
    });
    bundle.resourceIndex = index;
    bundle.resourceOffset = bundleOffset;
    bundle.textureOffset = textureOffset;
    bundles.push(bundle);
    diagnostics.push(...bundle.diagnostics);
  }

  if (bundles.length === 0) {
    throw new XenoFormatError('Battle sprite resource contains no supported 2D bundles', 'NO_SPRITE_BUNDLES', {
      spriteCount,
    });
  }
  return { format, bundles, diagnostics };
}
