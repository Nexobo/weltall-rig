import crypto from 'node:crypto';

import { XenoFormatError } from '../xeno/binary-reader.js';
import { decodePsxSpriteColor } from '../xeno/sprite-bundle.js';

const VRAM_BYTES = 1024 * 512 * 2;
const BLEND_MODES = ['average', 'add', 'subtract', 'add-quarter'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function invalid(message, details = {}) {
  throw new XenoFormatError(message, 'INVALID_BATTLE_TMD_MATERIAL', details);
}

function byte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function validatePrimitive(primitive, index) {
  if (
    primitive?.index !== index
    || ['textured', 'gouraud', 'lightingEnabled', 'semiTransparent', 'rawTexture']
      .some(key => typeof primitive[key] !== 'boolean')
    || !['none', 'single-normal', 'vertex-normals', 'neutral-color'].includes(primitive.lighting)
    || !Array.isArray(primitive.colors)
    || primitive.colors.some(color => !Array.isArray(color) || color.length !== 3 || !color.every(byte))
  ) invalid('TMD material requires an ordered primitive with typed color and rendering fields.', { index });
  if (!primitive.textured) {
    if (primitive.texture !== null) invalid('Untextured TMD primitive has texture fields.', { index });
    return;
  }
  const texture = primitive.texture;
  if (
    !texture || !Number.isInteger(texture.page) || texture.page < 0 || texture.page > 65535
    || !Number.isInteger(texture.clut) || texture.clut < 0 || texture.clut > 65535
    || !Array.isArray(texture.uvs) || ![3, 4].includes(texture.uvs.length)
    || texture.uvs.some(uv => !Array.isArray(uv) || uv.length !== 2 || !uv.every(byte))
  ) invalid('Textured TMD primitive requires a page, palette and triangle or quad texture coordinates.', { index });
}

function readTexture(primitive, context) {
  const { page, clut, uvs } = primitive.texture;
  const depth = (page >>> 7) & 3;
  if (depth === 3 || (page & 0x800) !== 0) return {
    code: 'BATTLE_TMD_TEXTURE_MODE_UNSUPPORTED',
    message: 'TMD texture requires an unsupported texture depth or extended VRAM page.',
    details: { primitiveIndex: primitive.index, depth, extendedPage: (page & 0x800) !== 0 },
  };
  if (context === null) return {
    code: 'BATTLE_TMD_TEXTURE_CONTEXT_REQUIRED',
    message: 'Textured TMD primitive requires source-owned VRAM image and palette words.',
    details: { primitiveIndex: primitive.index },
  };

  const { vram, initialized } = context;
  const x = Math.min(...uvs.map(uv => uv[0]));
  const y = Math.min(...uvs.map(uv => uv[1]));
  const width = Math.max(...uvs.map(uv => uv[0])) - x + 1;
  const height = Math.max(...uvs.map(uv => uv[1])) - y + 1;
  const pageX = (page & 15) * 64;
  const pageY = ((page >>> 4) & 1) * 256;
  const paletteX = (clut & 63) * 16;
  const paletteY = (clut >>> 6) & 511;
  const paletteSize = depth === 0 ? 16 : depth === 1 ? 256 : 0;
  const owned = (offset, length) => offset >= 0 && offset + length <= VRAM_BYTES
    && initialized.subarray(offset, offset + length).every(value => value === 1);
  const palette = [];
  for (let index = 0; index < paletteSize; index += 1) {
    // Palette X wraps in the same VRAM row, rather than spilling into the next row.
    const offset = (paletteY * 1024 + ((paletteX + index) & 1023)) * 2;
    if (!owned(offset, 2)) return {
      code: 'BATTLE_TMD_PALETTE_CONTEXT_REQUIRED',
      message: 'TMD palette contains a word outside the supplied source-owned uploads.',
      details: { primitiveIndex: primitive.index, paletteIndex: index },
    };
    palette.push(vram[offset] | (vram[offset + 1] << 8));
  }

  const rgba = new Uint8Array(width * height * 4);
  const semiTransparentMask = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const u = x + column;
      const v = y + row;
      const wordX = (pageX + (depth === 0 ? u >>> 2 : depth === 1 ? u >>> 1 : u)) & 1023;
      const offset = (((pageY + v) & 511) * 1024 + wordX) * 2;
      const byteOffset = offset + (depth === 0 ? (u >>> 1) & 1 : depth === 1 ? u & 1 : 0);
      if (!owned(byteOffset, depth === 2 ? 2 : 1)) return {
        code: 'BATTLE_TMD_TEXTURE_CONTEXT_REQUIRED',
        message: 'TMD texture rectangle contains a texel outside the supplied source-owned uploads.',
        details: { primitiveIndex: primitive.index, u, v },
      };
      const colorWord = depth === 0 ? palette[(vram[byteOffset] >>> ((u & 1) * 4)) & 15]
        : depth === 1 ? palette[vram[byteOffset]]
          : vram[byteOffset] | (vram[byteOffset + 1] << 8);
      // GPU transparency depends on the color word, not on the palette index.
      const color = decodePsxSpriteColor(colorWord, colorWord === 0 ? 0 : 1);
      const pixel = row * width + column;
      rgba.set([color.red, color.green, color.blue, color.alpha], pixel * 4);
      semiTransparentMask[pixel] = color.semiTransparent ? 1 : 0;
    }
  }
  return {
    texture: {
      id: `tmd-texture-${primitive.index}`,
      width, height,
      rgba: [...rgba],
      rgbaSha256: sha256(rgba),
      semiTransparentMask: [...semiTransparentMask],
      semiTransparentMaskSha256: sha256(semiTransparentMask),
    },
    origin: [x, y],
  };
}

/** Normalize authored TMD materials using only explicitly owned build-time VRAM. */
export function decodeBattleTmdTextures(primitives, context) {
  if (!Array.isArray(primitives)) throw new TypeError('TMD materials require an ordered primitive array.');
  if (context !== null && (
    !(context?.vram instanceof Uint8Array) || context.vram.length !== VRAM_BYTES
    || !(context.initialized instanceof Uint8Array) || context.initialized.length !== VRAM_BYTES
  )) throw new TypeError('TMD textures require explicit VRAM bytes and byte ownership, or null.');
  const textures = [];
  const textureCache = new Map();
  const diagnostics = [];
  const materials = primitives.map((primitive, index) => {
    validatePrimitive(primitive, index);
    const colors = primitive.colors.map(color => [...color]);
    const material = {
      primitiveIndex: index,
      textured: primitive.textured,
      colorInterpolation: primitive.gouraud ? 'vertex' : 'flat',
      lightingEnabled: primitive.lightingEnabled,
      lighting: primitive.lighting,
      colors,
      initialPacketColors: primitive.textured && primitive.lightingEnabled
        ? Array.from({ length: primitive.gouraud ? primitive.texture.uvs.length : 1 }, () => [128, 128, 128])
        : colors.map(color => [...color]),
      authoredSemiTransparent: primitive.semiTransparent,
      authoredBlendMode: primitive.textured ? BLEND_MODES[(primitive.texture.page >>> 5) & 3] : null,
      textureId: null,
      textureCoordinates: null,
    };
    if (primitive.textured) {
      const { page, clut, uvs } = primitive.texture;
      const cacheKey = [page, clut,
        Math.min(...uvs.map(uv => uv[0])), Math.max(...uvs.map(uv => uv[0])),
        Math.min(...uvs.map(uv => uv[1])), Math.max(...uvs.map(uv => uv[1])),
      ].join('/');
      const cached = textureCache.get(cacheKey);
      const decoded = cached ?? readTexture(primitive, context);
      if (decoded.code) diagnostics.push(decoded);
      else {
        if (!cached) {
          textures.push(decoded.texture);
          textureCache.set(cacheKey, decoded);
        }
        material.textureId = decoded.texture.id;
        material.textureCoordinates = uvs.map(([u, v]) => [u - decoded.origin[0], v - decoded.origin[1]]);
      }
    }
    return material;
  });
  return {
    materials,
    textures,
    // Battle 800bea2c installs its neutral DRAWENV window before the character
    // OT. Its draw-mode packets preserve that state (see authenticated tests).
    sampling: { textureWindow: 'disabled', coordinates: 'texel coordinates relative to the decoded texture', interpolation: 'affine', filtering: 'nearest' },
    actorControls: {
      appliedWhen: 'the sprite actor attaches the model',
      textureColor: {
        source: 'actor raw-texture flag',
        enabled: 'sample texture color directly',
        disabled: 'multiply texture color by interpolated primitive color divided by 128',
        authoredRawTextureFlag: 'replaced by the actor raw-texture flag',
      },
      blending: {
        source: 'actor blend selector',
        zero: 'preserve authored semitransparency and texture blend mode',
        nonzero: 'enable semitransparency and select the listed blend mode',
        modesBySelector: [null, ...BLEND_MODES, ...BLEND_MODES.slice(0, 3)],
        texturedPixels: 'blend only pixels whose semiTransparentMask is 1; discard alpha-zero pixels',
        untexturedModeWhenZero: 'current scene blend mode',
      },
      blendEquations: {
        average: '(background + foreground) / 2',
        add: 'background + foreground',
        subtract: 'background - foreground',
        'add-quarter': 'background + foreground / 4',
      },
    },
    diagnostics,
    complete: diagnostics.length === 0,
  };
}
