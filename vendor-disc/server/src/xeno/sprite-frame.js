import { BinaryReader, XenoFormatError, assertRange } from './binary-reader.js';

const MAX_FRAME_PARTS = 0x3f;
const MAX_FRAME_COMMANDS = 1024;
const SPRITE_SUBGROUP_COUNT = 8;
const VRAM_ROW_BYTES = 2048;
const PSX_TEXTURE_COORDINATE_MASK = 0xff;
const EXTENDED_TPAGE_LOCATIONS = [
  [0x300, 0x000],
  [0x340, 0x000],
  [0x380, 0x000],
  [0x3c0, 0x000],
  [0x300, 0x100],
  [0x340, 0x100],
  [0x380, 0x100],
  [0x3c0, 0x100],
];

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function signedByte(value) {
  return value > 0x7f ? value - 0x100 : value;
}

function normalizeTextureWindow(textureWindow) {
  if (textureWindow === null || textureWindow === undefined) {
    return { maskX: 0, maskY: 0, offsetX: 0, offsetY: 0 };
  }
  if (typeof textureWindow !== 'object') {
    throw new TypeError('Sprite texture window must be an object');
  }

  const normalized = {};
  for (const field of ['maskX', 'maskY', 'offsetX', 'offsetY']) {
    const value = textureWindow[field] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > 0x1f) {
      throw new RangeError(`Sprite texture window ${field} must be an integer between 0 and 31`);
    }
    normalized[field] = value;
  }
  return normalized;
}

function textureWindowActive(textureWindow) {
  return textureWindow.maskX !== 0 || textureWindow.maskY !== 0;
}

// GP0(E2): replace the masked U/V bits with the masked offset bits. Both
// fields are encoded in eight-pixel units and texture coordinates are bytes.
function applyTextureWindowCoordinate(coordinate, mask, offset) {
  const byteCoordinate = coordinate & PSX_TEXTURE_COORDINATE_MASK;
  const bitMask = (mask & 0x1f) << 3;
  return ((byteCoordinate & ~bitMask) | ((offset & mask) << 3))
    & PSX_TEXTURE_COORDINATE_MASK;
}

export function createSpriteSubgroupState() {
  return Array.from({ length: SPRITE_SUBGROUP_COUNT }, () => ({
    translateX: 0,
    translateY: 0,
    rotationRaw: 0,
  }));
}

function cloneSpriteSubgroupState(subgroupState) {
  return Array.from({ length: SPRITE_SUBGROUP_COUNT }, (_, groupId) => ({
    translateX: subgroupState?.[groupId]?.translateX ?? 0,
    translateY: subgroupState?.[groupId]?.translateY ?? 0,
    rotationRaw: subgroupState?.[groupId]?.rotationRaw ?? 0,
  }));
}

function applySubgroupCommand(subgroupState, command) {
  const transform = subgroupState[command.groupId];
  if (command.hasTranslation) {
    transform.translateX = command.translateX;
    transform.translateY = command.translateY;
  }
  transform.rotationRaw = command.hasRotation ? command.rotationRaw : 0;
}

export function resolveSpriteFrameTransforms(frame, subgroupState = null) {
  const nextSubgroupState = cloneSpriteSubgroupState(subgroupState);
  const commands = frame.subgroupCommands ?? [];
  let appliedCommandCount = 0;
  const parts = frame.parts.map((part) => {
    const requiredCommandCount = part.subgroupCommandCount ?? commands.length;
    while (appliedCommandCount < requiredCommandCount) {
      applySubgroupCommand(nextSubgroupState, commands[appliedCommandCount]);
      appliedCommandCount += 1;
    }
    const transform = nextSubgroupState[part.groupId];
    return {
      ...part,
      translateX: transform.translateX,
      translateY: transform.translateY,
      rotationRaw: transform.rotationRaw,
      rotationRadians: transform.rotationRaw * Math.PI / 128,
    };
  });

  while (appliedCommandCount < commands.length) {
    applySubgroupCommand(nextSubgroupState, commands[appliedCommandCount]);
    appliedCommandCount += 1;
  }

  return {
    frame: { ...frame, parts },
    subgroupState: nextSubgroupState,
  };
}

function unpack4BitPixels(source, pixelCount) {
  const output = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const packed = source[index >> 1];
    output[index] = (index & 1) === 0 ? packed & 0x0f : packed >> 4;
  }
  return output;
}

function cropIndexedPage(page, x, y, width, height, textureWindow) {
  if (!page || !Number.isInteger(page.width) || !Number.isInteger(page.height) || !page.pixels) {
    return null;
  }

  const output = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const sourceY = applyTextureWindowCoordinate(
      y + row,
      textureWindow.maskY,
      textureWindow.offsetY,
    );
    if (sourceY >= page.height) return null;
    for (let column = 0; column < width; column += 1) {
      const sourceX = applyTextureWindowCoordinate(
        x + column,
        textureWindow.maskX,
        textureWindow.offsetX,
      );
      if (sourceX >= page.width) return null;
      output[row * width + column] = page.pixels[sourceY * page.width + sourceX];
    }
  }
  return output;
}

function decodeVramColor(value, colorIndex) {
  return {
    value,
    red: Math.floor((((value & 31) * 255) + 15) / 31),
    green: Math.floor(((((value >> 5) & 31) * 255) + 15) / 31),
    blue: Math.floor(((((value >> 10) & 31) * 255) + 15) / 31),
    alpha: colorIndex === 0 ? 0 : 255,
    semiTransparent: (value & 0x8000) !== 0,
  };
}

function readVramPalette(vram, clutX, clutY, colorCount) {
  const colors = [];
  for (let colorIndex = 0; colorIndex < colorCount; colorIndex += 1) {
    const offset = clutY * VRAM_ROW_BYTES + (clutX + colorIndex) * 2;
    assertRange(vram, offset, 2, 'sprite CLUT in VRAM');
    const value = vram[offset] | (vram[offset + 1] << 8);
    colors.push(decodeVramColor(value, colorIndex));
  }
  return { colors, clutX, clutY };
}

export function readVramPixels(
  vram,
  tpageX,
  tpageY,
  sourceX,
  sourceY,
  width,
  height,
  bitsPerPixel,
  textureWindow,
) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const v = applyTextureWindowCoordinate(
      sourceY + y,
      textureWindow.maskY,
      textureWindow.offsetY,
    );
    const rowOffset = (tpageY + v) * VRAM_ROW_BYTES + tpageX * 2;
    for (let x = 0; x < width; x += 1) {
      const u = applyTextureWindowCoordinate(
        sourceX + x,
        textureWindow.maskX,
        textureWindow.offsetX,
      );
      let colorIndex;
      if (bitsPerPixel === 8) {
        assertRange(vram, rowOffset + u, 1, '8-bit sprite pixels in VRAM');
        colorIndex = vram[rowOffset + u];
      } else {
        assertRange(vram, rowOffset + (u >> 1), 1, '4-bit sprite pixels in VRAM');
        const packed = vram[rowOffset + (u >> 1)];
        colorIndex = (u & 1) === 0 ? packed & 0x0f : packed >> 4;
      }
      pixels[y * width + x] = colorIndex;
    }
  }
  return pixels;
}

function readEmbeddedImage(reader, descriptorOffset, diagnostics, frameId, partIndex) {
  reader.check(descriptorOffset, 4);
  const imageOffset = reader.u16(descriptorOffset) * 4;
  const descriptorFlags = reader.u16(descriptorOffset + 2);
  reader.check(imageOffset, 4);

  const width = reader.u8(imageOffset);
  const height = reader.u8(imageOffset + 1);
  const bitsPerPixel = reader.u8(imageOffset + 2) === 0 ? 4 : 8;
  const pixelCount = width * height;
  const byteCount = bitsPerPixel === 4 ? Math.ceil(pixelCount / 2) : pixelCount;

  if (width === 0 || height === 0) {
    diagnostics.push(diagnostic('EMPTY_SPRITE_PART', 'Sprite part has zero width or height', {
      frameId,
      partIndex,
      imageOffset,
    }));
    return { width, height, bitsPerPixel, pixels: new Uint8Array(), imageOffset, descriptorFlags };
  }

  assertRange(reader.buffer, imageOffset + 4, byteCount, 'embedded sprite pixels');
  const packed = reader.slice(imageOffset + 4, byteCount);
  const pixels = bitsPerPixel === 4
    ? unpack4BitPixels(packed, pixelCount)
    : Uint8Array.from(packed);

  return { width, height, bitsPerPixel, pixels, imageOffset, descriptorFlags };
}

function readPrebackedImage(
  reader,
  descriptorOffset,
  texturePages,
  vram,
  diagnostics,
  frameId,
  partIndex,
  textureWindow,
) {
  const imageDescriptionOffset = reader.u16(descriptorOffset);
  reader.check(imageDescriptionOffset, 5);

  const flags = reader.u8(imageDescriptionOffset);
  const extended = (flags & 0x10) !== 0;
  if (extended) {
    reader.check(imageDescriptionOffset, 6);
    const extension = reader.u8(imageDescriptionOffset + 1);
    const descriptor = flags | (extension << 8);
    const bitsPerPixel = (flags & 1) === 0 ? 4 : 8;
    const sourceX = reader.u8(imageDescriptionOffset + 2);
    const sourceY = reader.u8(imageDescriptionOffset + 3);
    const width = reader.u8(imageDescriptionOffset + 4);
    const height = reader.u8(imageDescriptionOffset + 5);
    const texturePage = (descriptor >> 1) & 7;
    const [tpageX, tpageY] = EXTENDED_TPAGE_LOCATIONS[texturePage];
    const clutX = (descriptor >> 1) & 0xf0;
    const clutY = 0x1cc + ((descriptor >> 9) & 0x0f);
    const pixels = vram
      ? readVramPixels(
        vram,
        tpageX,
        tpageY,
        sourceX,
        sourceY,
        width,
        height,
        bitsPerPixel,
        textureWindow,
      )
      : null;
    const palette = vram
      ? readVramPalette(vram, clutX, clutY, bitsPerPixel === 8 ? 256 : 16)
      : null;

    if (!vram) {
      diagnostics.push(diagnostic(
        'MISSING_VRAM',
        'Extended sprite frame descriptor requires its paired PlayStation VRAM upload',
        { frameId, partIndex, texturePage, tpageX, tpageY, clutX, clutY },
      ));
    }

    return {
      width,
      height,
      bitsPerPixel,
      pixels,
      palette,
      imageOffset: imageDescriptionOffset,
      texturePage,
      sourceX,
      sourceY,
      descriptorFlags: flags,
      descriptorExtension: extension,
      extended,
      tpageX,
      tpageY,
      clutX,
      clutY,
      textureWindow,
    };
  }

  const texturePage = flags >> 1;
  const bitsPerPixel = (flags & 1) === 0 ? 4 : 8;
  const sourceX = reader.u8(imageDescriptionOffset + 1);
  const sourceY = reader.u8(imageDescriptionOffset + 2);
  const width = reader.u8(imageDescriptionOffset + 3);
  const height = reader.u8(imageDescriptionOffset + 4);
  const pixels = cropIndexedPage(
    texturePages?.[texturePage],
    sourceX,
    sourceY,
    width,
    height,
    textureWindow,
  );

  if (!pixels) {
    diagnostics.push(diagnostic(
      'MISSING_TEXTURE_PAGE',
      'Sprite frame references a texture page that was not supplied or is out of bounds',
      { frameId, partIndex, texturePage, sourceX, sourceY, width, height },
    ));
  }

  return {
    width,
    height,
    bitsPerPixel,
    pixels,
    imageOffset: imageDescriptionOffset,
    texturePage,
    sourceX,
    sourceY,
    descriptorFlags: flags,
    descriptorExtension: null,
    extended: false,
    textureWindow,
  };
}

function parseFrame(reader, frameOffset, frameId, isVramPrebacked, texturePages, vram, textureWindow) {
  reader.check(frameOffset, 6);
  const diagnostics = [];
  if (!isVramPrebacked && textureWindowActive(textureWindow)) {
    diagnostics.push(diagnostic(
      'PSX_TEXTURE_WINDOW_CONTEXT_REQUIRED',
      'Texture-window sampling of embedded sprite pixels requires their runtime VRAM placement',
      { frameId },
    ));
  }
  const frameFlags = reader.u8(frameOffset);
  const partCount = frameFlags & MAX_FRAME_PARTS;
  const widePositions = (frameFlags & 0x80) !== 0;
  const imageTableOffset = frameOffset + (isVramPrebacked ? 4 : 6);
  const imageRecordSize = isVramPrebacked ? 2 : 4;
  const commandsOffset = imageTableOffset + partCount * imageRecordSize;
  reader.check(imageTableOffset, partCount * imageRecordSize);

  const parts = [];
  const subgroupCommands = [];
  const subgroupState = createSpriteSubgroupState();
  let commandOffset = commandsOffset;
  let commandCount = 0;
  let flipY = false;
  let widthAdjustment = 0;
  let heightAdjustment = 0;
  let groupId = 4;

  while (parts.length < partCount) {
    if (commandCount >= MAX_FRAME_COMMANDS) {
      throw new XenoFormatError('Sprite frame command stream did not terminate', 'SPRITE_FRAME_COMMAND_LIMIT', {
        frameId,
        frameOffset,
        partCount,
      });
    }
    commandCount += 1;
    const opcodeOffset = commandOffset;
    const opcode = reader.u8(commandOffset);
    commandOffset += 1;

    if ((opcode & 0x80) === 0) {
      let x;
      let y;
      if (widePositions) {
        x = reader.i16(commandOffset);
        y = reader.i16(commandOffset + 2);
        commandOffset += 4;
      } else {
        x = signedByte(reader.u8(commandOffset));
        y = signedByte(reader.u8(commandOffset + 1));
        commandOffset += 2;
      }

      const partIndex = parts.length;
      const descriptorOffset = imageTableOffset + partIndex * imageRecordSize;
      const image = isVramPrebacked
        ? readPrebackedImage(
          reader,
          descriptorOffset,
          texturePages,
          vram,
          diagnostics,
          frameId,
          partIndex,
          textureWindow,
        )
        : readEmbeddedImage(reader, descriptorOffset, diagnostics, frameId, partIndex);
      const transform = subgroupState[groupId];
      const blendControl = (opcode >> 4) & 3;

      parts.push({
        index: partIndex,
        opcodeOffset,
        x,
        y,
        width: image.width,
        height: image.height,
        displayWidth: image.width + widthAdjustment,
        displayHeight: image.height + heightAdjustment,
        widthAdjustment,
        heightAdjustment,
        bitsPerPixel: image.bitsPerPixel,
        pixels: image.pixels,
        imageOffset: image.imageOffset,
        texturePage: image.texturePage ?? null,
        sourceX: image.sourceX ?? 0,
        sourceY: image.sourceY ?? 0,
        descriptorFlags: image.descriptorFlags,
        descriptorExtension: image.descriptorExtension ?? null,
        extendedDescriptor: image.extended ?? false,
        palette: image.palette ?? null,
        tpageX: image.tpageX ?? null,
        tpageY: image.tpageY ?? null,
        clutX: image.clutX ?? null,
        clutY: image.clutY ?? null,
        textureWindow: image.textureWindow ?? null,
        paletteIndex: opcode & 0x0f,
        // Xenogears stores a blend control here: zero inherits the actor
        // control, while 1..3 enable ABE and select ABR control - 1.
        blendMode: blendControl,
        blendControl,
        abrMode: blendControl === 0 ? null : blendControl - 1,
        semiTransparent: blendControl !== 0,
        usesActorBlendMode: blendControl === 0,
        flipX: (opcode & 0x40) !== 0,
        flipY,
        groupId,
        subgroupCommandCount: subgroupCommands.length,
        translateX: transform.translateX,
        translateY: transform.translateY,
        rotationRaw: transform.rotationRaw,
        rotationRadians: transform.rotationRaw * Math.PI / 128,
      });
      flipY = false;
      widthAdjustment = 0;
      heightAdjustment = 0;
      continue;
    }

    if ((opcode & 0x40) === 0) {
      if ((opcode & 0x04) !== 0) flipY = true;
      if ((opcode & 0x01) !== 0) {
        widthAdjustment = signedByte(reader.u8(commandOffset));
        commandOffset += 1;
      }
      if ((opcode & 0x02) !== 0) {
        heightAdjustment = signedByte(reader.u8(commandOffset));
        commandOffset += 1;
      }
      continue;
    }

    groupId = opcode & 7;
    const subgroupCommand = {
      groupId,
      hasTranslation: (opcode & 0x20) !== 0,
      translateX: 0,
      translateY: 0,
      hasRotation: (opcode & 0x10) !== 0,
      rotationRaw: 0,
    };
    if ((opcode & 0x20) !== 0) {
      subgroupCommand.translateX = signedByte(reader.u8(commandOffset));
      subgroupCommand.translateY = signedByte(reader.u8(commandOffset + 1));
      commandOffset += 2;
    }
    if ((opcode & 0x10) !== 0) {
      subgroupCommand.rotationRaw = reader.u8(commandOffset);
      commandOffset += 1;
    }
    subgroupCommands.push(subgroupCommand);
    applySubgroupCommand(subgroupState, subgroupCommand);
  }

  return {
    id: frameId,
    offset: frameOffset,
    flags: frameFlags,
    widePositions,
    header: Uint8Array.from(reader.slice(frameOffset, isVramPrebacked ? 4 : 6)),
    parts,
    subgroupCommands,
    commandBytes: commandOffset - commandsOffset,
    diagnostics,
  };
}

function createActorTransform({
  flipX = false,
  flipY = false,
  actorScaleX = 1,
  actorScaleY = 1,
  actorRotationRadians = 0,
} = {}) {
  if (typeof flipX !== 'boolean' || typeof flipY !== 'boolean') {
    throw new TypeError('Sprite actor flips must be booleans');
  }
  for (const [name, value] of Object.entries({ actorScaleX, actorScaleY, actorRotationRadians })) {
    if (!Number.isFinite(value)) throw new TypeError(`Sprite ${name} must be finite`);
  }

  return {
    scaleX: (flipX ? -1 : 1) * actorScaleX,
    scaleY: (flipY ? -1 : 1) * actorScaleY,
    cosine: Math.cos(actorRotationRadians),
    sine: Math.sin(actorRotationRadians),
  };
}

function transformedPoint(part, x, y, actorTransform) {
  const partCosine = Math.cos(part.rotationRadians);
  const partSine = Math.sin(part.rotationRadians);
  const translatedX = x + part.x;
  const translatedY = y + part.y;
  const subgroupX = translatedX * partCosine - translatedY * partSine + part.translateX;
  const subgroupY = translatedX * partSine + translatedY * partCosine + part.translateY;
  const scaledX = subgroupX * actorTransform.scaleX;
  const scaledY = subgroupY * actorTransform.scaleY;
  const worldX = scaledX * actorTransform.cosine - scaledY * actorTransform.sine;
  const worldY = scaledX * actorTransform.sine + scaledY * actorTransform.cosine;
  const snapInteger = (value) => (
    Math.abs(value - Math.round(value)) < 1e-10 ? Math.round(value) : value
  );
  return { x: snapInteger(worldX), y: snapInteger(worldY) };
}

function inverseTransformedPoint(part, worldX, worldY, actorTransform) {
  const rotatedX = worldX * actorTransform.cosine + worldY * actorTransform.sine;
  const rotatedY = -worldX * actorTransform.sine + worldY * actorTransform.cosine;
  const subgroupX = rotatedX / actorTransform.scaleX - part.translateX;
  const subgroupY = rotatedY / actorTransform.scaleY - part.translateY;
  const partCosine = Math.cos(part.rotationRadians);
  const partSine = Math.sin(part.rotationRadians);
  return {
    x: subgroupX * partCosine + subgroupY * partSine - part.x,
    y: -subgroupX * partSine + subgroupY * partCosine - part.y,
  };
}

function getPartBounds(part, actorTransform) {
  const corners = [
    transformedPoint(part, 0, 0, actorTransform),
    transformedPoint(part, part.displayWidth, 0, actorTransform),
    transformedPoint(part, part.displayWidth, part.displayHeight, actorTransform),
    transformedPoint(part, 0, part.displayHeight, actorTransform),
  ];
  return {
    minX: Math.floor(Math.min(...corners.map((point) => point.x))),
    minY: Math.floor(Math.min(...corners.map((point) => point.y))),
    maxX: Math.ceil(Math.max(...corners.map((point) => point.x))),
    maxY: Math.ceil(Math.max(...corners.map((point) => point.y))),
  };
}

function paletteColor(part, palettes, colorIndex) {
  const palette = part.palette ?? palettes?.[part.paletteIndex];
  const color = palette?.colors?.[colorIndex] ?? palette?.[colorIndex];
  if (!color) {
    return null;
  }
  if (Array.isArray(color) || color instanceof Uint8Array) {
    return { red: color[0], green: color[1], blue: color[2], alpha: color[3] };
  }
  return color;
}

function normalizeActorColor(actorColor) {
  const color = actorColor ?? { red: 0x80, green: 0x80, blue: 0x80 };
  const normalized = {};
  for (const channel of ['red', 'green', 'blue']) {
    const value = color[channel] ?? 0x80;
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`Sprite actor color ${channel} must be an integer between 0 and 255`);
    }
    normalized[channel] = value;
  }
  return normalized;
}

function modulateColor(color, actorColor, actorRawTexture) {
  if (actorRawTexture) return color;
  return {
    ...color,
    red: clampByte(color.red * actorColor.red / 0x80),
    green: clampByte(color.green * actorColor.green / 0x80),
    blue: clampByte(color.blue * actorColor.blue / 0x80),
  };
}

function compositeAlphaPixel(output, outputOffset, color) {
  const sourceAlpha = color.alpha / 255;
  if (sourceAlpha <= 0) {
    return;
  }
  const destinationAlpha = output[outputOffset + 3] / 255;
  const combinedAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (combinedAlpha <= 0) {
    return;
  }

  output[outputOffset] = Math.round(
    (color.red * sourceAlpha + output[outputOffset] * destinationAlpha * (1 - sourceAlpha)) / combinedAlpha,
  );
  output[outputOffset + 1] = Math.round(
    (color.green * sourceAlpha + output[outputOffset + 1] * destinationAlpha * (1 - sourceAlpha)) / combinedAlpha,
  );
  output[outputOffset + 2] = Math.round(
    (color.blue * sourceAlpha + output[outputOffset + 2] * destinationAlpha * (1 - sourceAlpha)) / combinedAlpha,
  );
  output[outputOffset + 3] = Math.round(combinedAlpha * 255);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.floor(value)));
}

function psxBlendChannel(background, foreground, abrMode) {
  if (abrMode === 0) return Math.floor(background / 2) + Math.floor(foreground / 2);
  if (abrMode === 1) return clampByte(background + foreground);
  if (abrMode === 2) return clampByte(background - foreground);
  return clampByte(background + foreground / 4);
}

function resolvePartBlend(part, actorBlendControl) {
  const partBlendControl = Number.isInteger(part.blendControl)
    ? part.blendControl
    : Number.isInteger(part.blendMode)
      ? part.blendMode
      : 0;
  const effectiveControl = partBlendControl === 0 ? actorBlendControl : partBlendControl;
  return {
    enabled: effectiveControl !== 0,
    abrMode: effectiveControl === 0 ? 0 : (effectiveControl - 1) & 3,
  };
}

function compositePixel(output, outputOffset, color, blend) {
  const isPsxColor = Number.isInteger(color.value);
  if (isPsxColor && color.value === 0) return { framebufferContextRequired: false };

  const sourceSemiTransparent = isPsxColor && (color.value & 0x8000) !== 0;
  if (blend.enabled && sourceSemiTransparent) {
    const framebufferContextRequired = output[outputOffset + 3] === 0;
    output[outputOffset] = psxBlendChannel(output[outputOffset], color.red, blend.abrMode);
    output[outputOffset + 1] = psxBlendChannel(output[outputOffset + 1], color.green, blend.abrMode);
    output[outputOffset + 2] = psxBlendChannel(output[outputOffset + 2], color.blue, blend.abrMode);
    output[outputOffset + 3] = 255;
    return { framebufferContextRequired };
  }

  if (isPsxColor || color.alpha === 255 || color.alpha === undefined) {
    output[outputOffset] = color.red;
    output[outputOffset + 1] = color.green;
    output[outputOffset + 2] = color.blue;
    output[outputOffset + 3] = 255;
    return { framebufferContextRequired: false };
  }

  compositeAlphaPixel(output, outputOffset, color);
  return { framebufferContextRequired: false };
}

function normalizeClip(clip) {
  if (clip === null || clip === undefined) return null;
  if (typeof clip !== 'object') throw new TypeError('Sprite clip must be an object');
  const { x, y, width, height } = clip;
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new TypeError('Sprite clip x and y must be integers');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError('Sprite clip width and height must be non-negative integers');
  }
  return { x, y, width, height };
}

export function composeSpriteFrame(
  frame,
  palettes,
  {
    padding = 0,
    subgroupState = null,
    flipX = false,
    flipY = false,
    actorScaleX = 1,
    actorScaleY = 1,
    actorRotationRadians = 0,
    actorColor = null,
    actorRawTexture = false,
    actorBlendControl = 0,
    clip = null,
  } = {},
) {
  if (!Number.isInteger(padding) || padding < 0) {
    throw new RangeError('Sprite frame padding must be a non-negative integer');
  }
  if (!Number.isInteger(actorBlendControl) || actorBlendControl < 0 || actorBlendControl > 7) {
    throw new RangeError('Sprite actor blend control must be an integer between 0 and 7');
  }
  if (typeof actorRawTexture !== 'boolean') {
    throw new TypeError('Sprite actor raw-texture flag must be a boolean');
  }
  const normalizedClip = normalizeClip(clip);
  const normalizedActorColor = normalizeActorColor(actorColor);
  const actorTransform = createActorTransform({
    flipX,
    flipY,
    actorScaleX,
    actorScaleY,
    actorRotationRadians,
  });

  const resolved = resolveSpriteFrameTransforms(frame, subgroupState);
  const resolvedFrame = resolved.frame;
  const diagnostics = [...resolvedFrame.diagnostics];
  const missingPixels = resolvedFrame.parts.filter((part) => !part.pixels);
  if (missingPixels.length > 0) {
    return {
      renderable: false,
      width: 0,
      height: 0,
      originX: 0,
      originY: 0,
      rgba: null,
      subgroupState: resolved.subgroupState,
      diagnostics,
    };
  }

  for (const part of resolvedFrame.parts) {
    if (!part.palette && !palettes?.[part.paletteIndex]) {
      diagnostics.push(diagnostic('MISSING_PALETTE', 'Sprite part references a missing palette', {
        frameId: resolvedFrame.id,
        partIndex: part.index,
        paletteIndex: part.paletteIndex,
      }));
    }
  }
  if (diagnostics.some((entry) => entry.code === 'MISSING_PALETTE')) {
    return {
      renderable: false,
      width: 0,
      height: 0,
      originX: 0,
      originY: 0,
      rgba: null,
      subgroupState: resolved.subgroupState,
      diagnostics,
    };
  }

  if (resolvedFrame.parts.length === 0) {
    return {
      renderable: true,
      width: 1,
      height: 1,
      originX: 0,
      originY: 0,
      rgba: new Uint8Array(4),
      subgroupState: resolved.subgroupState,
      diagnostics,
    };
  }

  const partIsDrawable = (part) => (
    part.width !== 0
    && part.height !== 0
    && part.displayWidth !== 0
    && part.displayHeight !== 0
    && actorTransform.scaleX !== 0
    && actorTransform.scaleY !== 0
  );
  const drawableParts = resolvedFrame.parts.filter(partIsDrawable);
  if (drawableParts.length === 0) {
    return {
      renderable: true,
      width: 1,
      height: 1,
      originX: 0,
      originY: 0,
      rgba: new Uint8Array(4),
      subgroupState: resolved.subgroupState,
      diagnostics,
    };
  }

  const bounds = resolvedFrame.parts.map((part) => (
    partIsDrawable(part) ? getPartBounds(part, actorTransform) : null
  ));
  const drawableBounds = bounds.filter(Boolean);
  const minX = Math.min(...drawableBounds.map((partBounds) => partBounds.minX)) - padding;
  const minY = Math.min(...drawableBounds.map((partBounds) => partBounds.minY)) - padding;
  const maxX = Math.max(...drawableBounds.map((partBounds) => partBounds.maxX)) + padding;
  const maxY = Math.max(...drawableBounds.map((partBounds) => partBounds.maxY)) + padding;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const rgba = new Uint8Array(width * height * 4);
  let framebufferContextRequired = false;

  // Xenogears stores sprite parts front-to-back, so draw them in reverse order.
  for (let partIndex = resolvedFrame.parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = resolvedFrame.parts[partIndex];
    const partBounds = bounds[partIndex];
    const blend = resolvePartBlend(part, actorBlendControl);

    if (part.width === 0 || part.height === 0 || part.displayWidth === 0 || part.displayHeight === 0) {
      continue;
    }

    for (let worldY = partBounds.minY; worldY < partBounds.maxY; worldY += 1) {
      for (let worldX = partBounds.minX; worldX < partBounds.maxX; worldX += 1) {
        if (
          normalizedClip
          && (
            worldX < normalizedClip.x
            || worldY < normalizedClip.y
            || worldX >= normalizedClip.x + normalizedClip.width
            || worldY >= normalizedClip.y + normalizedClip.height
          )
        ) {
          continue;
        }
        const local = inverseTransformedPoint(
          part,
          worldX + 0.5,
          worldY + 0.5,
          actorTransform,
        );
        const localX = local.x;
        const localY = local.y;
        const normalizedX = localX / part.displayWidth;
        const normalizedY = localY / part.displayHeight;
        if (normalizedX < 0 || normalizedY < 0 || normalizedX >= 1 || normalizedY >= 1) {
          continue;
        }

        let sourceX = Math.floor(normalizedX * part.width);
        let sourceY = Math.floor(normalizedY * part.height);
        if (part.flipX) {
          sourceX = part.width - 1 - sourceX;
        }
        if (part.flipY) {
          sourceY = part.height - 1 - sourceY;
        }
        const colorIndex = part.pixels[sourceY * part.width + sourceX];
        const sourceColor = paletteColor(part, palettes, colorIndex);
        const color = sourceColor
          ? modulateColor(sourceColor, normalizedActorColor, actorRawTexture)
          : null;
        if (!color) {
          continue;
        }
        const outputOffset = ((worldY - minY) * width + worldX - minX) * 4;
        const result = compositePixel(rgba, outputOffset, color, blend);
        framebufferContextRequired ||= result.framebufferContextRequired;
      }
    }
  }

  if (framebufferContextRequired) {
    diagnostics.push(diagnostic(
      'PSX_FRAMEBUFFER_CONTEXT_REQUIRED',
      'A semi-transparent sprite texel was composited over transparent black because the scene framebuffer was not supplied',
      { frameId: resolvedFrame.id },
    ));
  }

  return {
    renderable: true,
    width,
    height,
    originX: minX,
    originY: minY,
    rgba,
    subgroupState: resolved.subgroupState,
    diagnostics,
  };
}

export function parseSpriteFrames(
  frameBuffer,
  {
    palettes = null,
    texturePages = null,
    vram = null,
    textureWindow = null,
    compose = true,
  } = {},
) {
  const buffer = Buffer.isBuffer(frameBuffer) ? frameBuffer : Buffer.from(frameBuffer);
  const reader = new BinaryReader(buffer, 'sprite frame data');
  const normalizedTextureWindow = normalizeTextureWindow(textureWindow);
  const header = reader.u16(0);
  const frameCount = header & 0x01ff;
  const isVramPrebacked = (header & 0x8000) !== 0;
  reader.check(2, frameCount * 2);

  const frames = new Array(frameCount + 1).fill(null);
  const diagnostics = [];
  for (let frameId = 1; frameId <= frameCount; frameId += 1) {
    const frameOffset = reader.u16(frameId * 2);
    if (frameOffset < 2 + frameCount * 2 || frameOffset >= buffer.length) {
      throw new XenoFormatError('Sprite frame offset is outside the frame entry', 'INVALID_SPRITE_FRAME_OFFSET', {
        frameId,
        frameOffset,
        frameDataLength: buffer.length,
      });
    }
    const frame = parseFrame(
      reader,
      frameOffset,
      frameId,
      isVramPrebacked,
      texturePages,
      vram,
      normalizedTextureWindow,
    );
    if (compose && palettes) {
      frame.image = composeSpriteFrame(frame, palettes);
    }
    frames[frameId] = frame;
    diagnostics.push(...frame.diagnostics);
  }

  return {
    header,
    frameCount,
    isVramPrebacked,
    textureWindow: normalizedTextureWindow,
    frames,
    diagnostics,
  };
}
