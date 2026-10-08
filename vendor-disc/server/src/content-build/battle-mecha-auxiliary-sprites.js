import crypto from 'node:crypto';

import { validateCleanContentValue } from '../../../shared/content/content-schema.js';
import { XenoFormatError } from '../xeno/binary-reader.js';
import { parseSpriteAnimations } from '../xeno/sprite-animation.js';
import { parseSpritePalettes } from '../xeno/sprite-bundle.js';
import { parseSpriteFrames } from '../xeno/sprite-frame.js';
import { compileSpriteAnimationProgram } from './sprite-program-compiler.js';
import { battleSpriteVariableBanks } from './battle-sprite-variable-banks.js';
import { battleScreenEffectParameters } from './battle-screen-effect-parameters.js';

const ROW_BYTES = 2048;
const VRAM_BYTES = ROW_BYTES * 512;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fail(message, details = {}) {
  throw new XenoFormatError(message, 'INVALID_BATTLE_MECHA_AUXILIARY_SPRITES', details);
}

function plainDiagnostic(value) {
  const { code, message, ...details } = value;
  return { code, message, details };
}

function splitMembers(bytes, sourceOffset) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 3) {
    fail('Battle mecha auxiliary sprite bundle requires exactly three members.');
  }
  const offsets = Array.from({ length: 4 }, (_, index) => bytes.readUInt32LE(4 + index * 4));
  if (
    offsets[0] !== 20
    || offsets[1] < offsets[0]
    || offsets[1] > bytes.length
    || (offsets[2] !== 0 && (offsets[2] < offsets[1] || offsets[2] > bytes.length))
    || offsets[3] !== bytes.length
  ) fail('Battle mecha auxiliary sprite member offsets do not partition the payload.', { offsets });
  const entries = offsets.slice(0, 3).map((offset, index) => {
    const end = offset === 0 ? 0 : offsets.slice(index + 1).find(value => value !== 0);
    const payload = bytes.subarray(offset, end);
    return {
      index,
      present: payload.length !== 0,
      sourceRange: { offset: sourceOffset + offset, length: payload.length },
      sha256: sha256(payload),
      payload,
    };
  });
  if (!entries[0].present || !entries[1].present) fail('Battle mecha auxiliary sprite animation and frame headers are required.');
  return { offsets, entries };
}

function uploadTextureWords(uploads, initialUploads) {
  const bytes = Buffer.alloc(VRAM_BYTES);
  const initialized = new Uint8Array(VRAM_BYTES);
  // Explicit inherited atlas words precede the resource's own uploads.
  // Unspecified memory remains unowned; this does not assume blank VRAM.
  for (const { x, y, widthWords, height, pixelWords } of initialUploads) {
    if (![x, y, widthWords, height].every(Number.isSafeInteger) || x < 0 || y < 0
      || widthWords < 1 || height < 1 || x + widthWords > 1024 || y + height > 512
      || pixelWords.length !== widthWords * height
      || pixelWords.some(word => !Number.isInteger(word) || word < 0 || word > 65535)) {
      fail('Inherited Battle texture context has an invalid rectangle.');
    }
    for (let row = 0; row < height; row++) {
      const start = ((y + row) * 1024 + x) * 2;
      for (let column = 0; column < widthWords; column++) bytes.writeUInt16LE(pixelWords[row * widthWords + column], start + column * 2);
      initialized.fill(1, start, start + widthWords * 2);
    }
  }
  for (const [index, upload] of uploads.entries()) {
    const { widthWords, height, pixelWords, relativeOrigin, kind } = upload;
    if (
      !['image', 'clut'].includes(kind)
      || !Number.isSafeInteger(widthWords) || widthWords < 1
      || !Number.isSafeInteger(height) || height < 1
      || !Number.isSafeInteger(relativeOrigin?.x) || relativeOrigin.x < 0
      || !Number.isSafeInteger(relativeOrigin?.y) || relativeOrigin.y < 0
      || !Array.isArray(pixelWords) || pixelWords.length !== widthWords * height
      || pixelWords.some(word => !Number.isSafeInteger(word) || word < 0 || word > 0xffff)
    ) fail('Battle mecha auxiliary texture upload is invalid.', { index });
    // Retail Battle opcode 5 supplies these image/CLUT bases to the packed-upload helper.
    const x = (kind === 'image' ? 896 : 0) + relativeOrigin.x;
    const y = (kind === 'image' ? 256 : 464) + relativeOrigin.y;
    if (x + widthWords > 1024 || y + height > 512) {
      fail('Battle mecha auxiliary texture upload lies outside VRAM.', { index, x, y, widthWords, height });
    }
    for (let row = 0; row < height; row += 1) {
      const start = (y + row) * ROW_BYTES + x * 2;
      for (let column = 0; column < widthWords; column += 1) {
        bytes.writeUInt16LE(pixelWords[row * widthWords + column], start + column * 2);
      }
      initialized.fill(1, start, start + widthWords * 2);
    }
  }
  return { bytes, initialized };
}

function windowCoordinate(value, mask, offset) {
  return ((value & 0xff) & ~(mask << 3)) | ((offset & mask) << 3);
}

function ownsPartTexture(part, initialized) {
  if (!part.extendedDescriptor) return true;
  const window = part.textureWindow;
  for (let row = 0; row < part.height; row += 1) {
    const v = windowCoordinate(part.sourceY + row, window.maskY, window.offsetY);
    const base = (part.tpageY + v) * ROW_BYTES + part.tpageX * 2;
    for (let column = 0; column < part.width; column += 1) {
      const u = windowCoordinate(part.sourceX + column, window.maskX, window.offsetX);
      if (initialized[base + (part.bitsPerPixel === 8 ? u : u >> 1)] !== 1) return false;
    }
  }
  const paletteBytes = (part.bitsPerPixel === 8 ? 256 : 16) * 2;
  const start = part.clutY * ROW_BYTES + part.clutX * 2;
  for (let offset = start; offset < start + paletteBytes; offset += 1) {
    if (initialized[offset] !== 1) return false;
  }
  return true;
}

function cleanColor(color) {
  // These palettes are the actual uploaded PSX CLUT. Transparency depends on
  // color word zero, not its palette index; 0x8000 remains visible black.
  return { red: color.red, green: color.green, blue: color.blue,
    alpha: color.value === 0 ? 0 : 255, semiTransparent: color.semiTransparent };
}

function cleanPart(part, palettes, initialized, diagnostics, frameId) {
  const ownsTexture = ownsPartTexture(part, initialized);
  const palette = part.palette ?? palettes[part.paletteIndex];
  const complete = ownsTexture && part.pixels?.length === part.width * part.height && palette?.colors?.length > 0;
  if (!complete) diagnostics.push({
    code: 'BATTLE_MECHA_SPRITE_TEXTURE_CONTEXT_REQUIRED',
    message: 'The auxiliary sprite part requires texture or palette bytes outside its supplied uploads.',
    details: { frameId, partIndex: part.index },
  });
  return {
    index: part.index,
    position: { x: part.x, y: part.y },
    width: part.width,
    height: part.height,
    displayWidth: part.displayWidth,
    displayHeight: part.displayHeight,
    widthAdjustment: part.widthAdjustment,
    heightAdjustment: part.heightAdjustment,
    bitsPerPixel: part.bitsPerPixel,
    pixels: complete ? [...part.pixels] : null,
    pixelSha256: complete ? sha256(part.pixels) : null,
    palette: complete ? palette.colors.map(cleanColor) : null,
    blendControl: part.blendControl,
    abrMode: part.abrMode,
    semiTransparent: part.semiTransparent,
    usesActorBlendMode: part.usesActorBlendMode,
    flipX: part.flipX,
    flipY: part.flipY,
    groupId: part.groupId,
    subgroupCommandCount: part.subgroupCommandCount,
    translateX: part.translateX,
    translateY: part.translateY,
    rotationRaw: part.rotationRaw,
  };
}

/** Decode the optional three-member sprite bundle in a Battle mecha auxiliary archive. */
export function decodeBattleMechaAuxiliarySprites(value, { sourceOffset, textureUploads, polygonShatterContract = null, initialTextureUploads = [] }) {
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || !Array.isArray(textureUploads)) {
    throw new TypeError('Auxiliary sprites require an explicit source offset and texture upload context.');
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const { offsets, entries } = splitMembers(bytes, sourceOffset);
  const animationSet = parseSpriteAnimations(entries[0].payload);
  const texture = uploadTextureWords(textureUploads, initialTextureUploads);
  const program = compileSpriteAnimationProgram(animationSet, {
    runtimeContext: 'battle', tmdVram: { vram: texture.bytes, initialized: texture.initialized }, polygonShatterContract,
  });
  const diagnostics = program.diagnostics.map(diagnostic => ({ ...diagnostic }));
  const paletteSet = entries[2].present ? parseSpritePalettes(entries[2].payload) : { palettes: [], diagnostics: [] };
  diagnostics.push(...paletteSet.diagnostics.map(plainDiagnostic));
  const frameSet = parseSpriteFrames(entries[1].payload, { palettes: paletteSet.palettes, vram: texture.bytes, compose: false });
  diagnostics.push(...frameSet.diagnostics.map(plainDiagnostic));
  const frames = frameSet.frames.filter(Boolean).map(frame => ({
    id: frame.id,
    sourceOffset: entries[1].sourceRange.offset + frame.offset,
    anchorOffsets: { top: frame.header[3], center: frame.header[1] },
    subgroupCommands: frame.subgroupCommands.map(command => ({ ...command })),
    parts: frame.parts.map(part => cleanPart(part, paletteSet.palettes, texture.initialized, diagnostics, frame.id)),
  }));
  for (const instruction of program.instructions) {
    const frameId = instruction.operands.find(operand => operand.name === 'frameId')?.value;
    if (Number.isInteger(frameId) && frameId !== 0 && !frameSet.frames[frameId]) diagnostics.push({
      code: 'BATTLE_MECHA_SPRITE_FRAME_CONTEXT_REQUIRED',
      message: 'The auxiliary sprite program references a frame outside its local frame bank.',
      details: { instructionOffset: instruction.offset, frameId },
    });
  }
  const result = {
    sourceRange: { offset: sourceOffset, length: bytes.length },
    sha256: sha256(bytes),
    container: {
      headerRange: { offset: sourceOffset, length: 20 },
      offsets,
      entries: entries.map(({ payload, ...entry }) => entry),
    },
    animationCount: animationSet.animationCount,
    program,
    variableBanks: battleSpriteVariableBanks(program, entries[0].payload),
    effectParameters: battleScreenEffectParameters(program, entries[0].payload),
    frameCount: frameSet.frameCount,
    frames,
    palettes: paletteSet.palettes.map(palette => ({ index: palette.index, colors: palette.colors.map(cleanColor) })),
    complete: diagnostics.length === 0,
    requiredContexts: [...new Set([
      ...program.requiredContexts,
      ...(diagnostics.some(diagnostic => diagnostic.code === 'BATTLE_MECHA_SPRITE_TEXTURE_CONTEXT_REQUIRED') ? ['battle-mecha-sprite-textures'] : []),
      ...(diagnostics.some(diagnostic => diagnostic.code === 'BATTLE_MECHA_SPRITE_FRAME_CONTEXT_REQUIRED') ? ['battle-mecha-sprite-frame-bank'] : []),
    ])].sort(),
    diagnostics,
  };
  validateCleanContentValue(result, 'Battle mecha auxiliary sprites');
  return result;
}
