import { BinaryReader, XenoFormatError } from './binary-reader.js';

const ABE_ALPHA = [128, 0, 0, 64];

class ShaderBuilder {
  constructor() {
    this.shaders = [];
    this.indices = new Map();
  }

  get(status, clut, semiTransparent, textured, hasVertexNormals) {
    const key = `${status}:${clut}:${semiTransparent ? 1 : 0}:${textured ? 1 : 0}:${hasVertexNormals ? 1 : 0}`;
    let index = this.indices.get(key);

    if (index === undefined) {
      index = this.shaders.length;
      this.indices.set(key, index);
      this.shaders.push({
        status,
        clut,
        semiTransparent,
        textured,
        hasVertexNormals,
        blendMode: (status >> 5) & 3,
      });
    }

    return index;
  }
}

function readVertex(reader, partOffset, vertexOffset, normalOffset, vertexIndex, vertexCount, hasNormal) {
  if (vertexIndex >= vertexCount) {
    throw new XenoFormatError('Mesh references a vertex outside its block', 'INVALID_VERTEX_INDEX', {
      vertexIndex,
      vertexCount,
    });
  }

  const positionOffset = partOffset + vertexOffset + vertexIndex * 8;
  const position = [
    reader.i16(positionOffset),
    reader.i16(positionOffset + 2),
    reader.i16(positionOffset + 4),
  ];

  let normal = [0, 0, 0];
  if (hasNormal) {
    const sourceOffset = partOffset + normalOffset + vertexIndex * 8;
    normal = [
      reader.i16(sourceOffset),
      reader.i16(sourceOffset + 2),
      reader.i16(sourceOffset + 4),
    ];
  }

  return { position, normal, vertexIndex };
}

function readPolygonVertices(reader, context, count, hasNormal) {
  const vertices = [];

  for (let index = 0; index < count; index += 1) {
    const vertexIndex = reader.u16(context.partOffset + context.meshDataOffset + index * 2);
    const vertex = readVertex(
      reader,
      context.partOffset,
      context.vertexOffset,
      context.normalOffset,
      vertexIndex,
      context.vertexCount,
      hasNormal,
    );
    vertex.deformations = context.deformations.map(target => target.get(vertexIndex) ?? [0, 0, 0]);
    vertices.push(vertex);
  }

  if (!hasNormal) {
    // Resident 8002DB84 uses the original first three vertices, before our winding conversion.
    const a = vertices[2].position.map((value, axis) => value - vertices[0].position[axis]);
    const b = vertices[1].position.map((value, axis) => value - vertices[0].position[axis]);
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const length = Math.hypot(...cross);
    const normal = length === 0 ? [0, 0, 0] : cross.map(value => Math.round(value * 4096 / length));
    // A flat quad shares one normal, even when its fourth vertex is not coplanar.
    vertices.forEach(vertex => { vertex.normal = [...normal]; });
  }

  context.meshDataOffset += 8;
  return vertices;
}

function rgbaFromCommand(command, semiTransparent, status) {
  const alpha = semiTransparent ? ABE_ALPHA[(status >> 5) & 3] : 255;
  return [
    (command >> 16) & 0xff,
    (command >> 8) & 0xff,
    command & 0xff,
    alpha,
  ];
}

export function parseFieldModel(modelBuffer) {
  const reader = new BinaryReader(modelBuffer, 'field model');
  const shaderBuilder = new ShaderBuilder();
  const diagnostics = [];
  const parts = [];
  const partCount = reader.u32(0);

  if (partCount > 4096) {
    throw new XenoFormatError('Unreasonable field model part count', 'INVALID_PART_COUNT', { partCount });
  }

  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const partOffset = reader.u32(4 + partIndex * 4);
    const blockCount = reader.u32(partOffset);
    const blocks = [];

    if (blockCount > 4096) {
      throw new XenoFormatError('Unreasonable field model block count', 'INVALID_BLOCK_COUNT', {
        partIndex,
        blockCount,
      });
    }

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const blockOffset = partOffset + 16 + blockIndex * 0x38;
      const vertexCount = reader.u16(blockOffset + 2);
      const meshCount = reader.u16(blockOffset + 4);
      const meshBlockCount = reader.u16(blockOffset + 6);
      const vertexOffset = reader.u32(blockOffset + 8);
      const normalOffset = reader.u32(blockOffset + 12);
      const deformationOffset = reader.u32(blockOffset + 0x1c);
      const deformations = [];
      if (deformationOffset !== 0) {
        const table = partOffset + deformationOffset, count = reader.u32(table);
        if (count > 32) throw new XenoFormatError('Too many Field deformation channels', 'INVALID_DEFORMATION_COUNT');
        for (let channel = 0; channel < count; channel++) {
          const row = table + 4 + channel * 12, vertexRows = reader.u32(row);
          const offsets = partOffset + reader.u32(row + 4), target = new Map();
          for (let index = 0; index < vertexRows; index++) {
            const at = offsets + index * 8, vertex = reader.u16(at + 6);
            if (vertex >= vertexCount) throw new XenoFormatError('Invalid Field deformation vertex', 'INVALID_DEFORMATION_VERTEX');
            target.set(vertex, [reader.i16(at), reader.i16(at + 2), reader.i16(at + 4)]);
          }
          deformations.push(target);
        }
      }
      const context = {
        deformations,
        partOffset,
        vertexOffset,
        normalOffset,
        vertexCount,
        meshDataOffset: reader.u32(blockOffset + 16),
        displayListOffset: reader.u32(blockOffset + 20),
      };
      const block = {
        texturedTriangles: [],
        texturedQuads: [],
        monochromeTriangles: [],
        monochromeQuads: [],
      };
      // EntityMoveCheck0 passes only the first model block to80083288. Keep
      // its native index order: render winding/triangulation is a different use.
      if (blockIndex === 0) block.collision = {
        vertices: Array.from({ length: vertexCount }, (_, index) =>
          readVertex(reader, partOffset, vertexOffset, normalOffset, index, vertexCount, false).position),
        faces: [],
        deformations: deformations.map(target => [...target].map(([vertexIndex, offset]) => ({ vertexIndex, offset }))),
      };
      let status = 0;
      let clut = 0;

      for (let meshBlockIndex = 0; meshBlockIndex < meshBlockCount; meshBlockIndex += 1) {
        const meshBlockHeader = partOffset + context.meshDataOffset;
        const primitiveType = reader.u8(meshBlockHeader);
        const polygonCount = reader.u16(meshBlockHeader + 2);
        context.meshDataOffset += 4;

        if (block.collision && primitiveType !== 0xc4 && primitiveType !== 0xc8) {
          for (let polygon = 0; polygon < polygonCount; polygon++) {
            const at = partOffset + context.meshDataOffset + polygon * 8;
            block.collision.faces.push(Array.from({ length: primitiveType & 8 ? 4 : 3 }, (_, corner) => {
              const index = reader.u16(at + corner * 2);
              if (index >= vertexCount) throw new XenoFormatError('Collision face references a missing vertex',
                'INVALID_VERTEX_INDEX', { partIndex, blockIndex, index, vertexCount });
              return index;
            }));
          }
        }

        // Retail reserves primitive type 0x10 without submitting a display list.
        // Its fixed-width mesh records still occupy the normal index stream.
        if (primitiveType === 0x10) {
          reader.check(partOffset + context.meshDataOffset, polygonCount * 8);
          context.meshDataOffset += polygonCount * 8;
          continue;
        }

        let polygonsRemaining = polygonCount;

        while (polygonsRemaining > 0) {
          const commandOffset = partOffset + context.displayListOffset;
          const command = reader.u32(commandOffset);
          const operator = command >>> 24;
          const hasNormal = (operator & 0x10) !== 0;
          const semiTransparent = (operator & 0x02) !== 0;
          const primitiveOperator = operator & ~(0x10 | 0x02 | 0x01);
          context.displayListOffset += 4;

          if (operator === 0xc4) {
            status = command & 0xffff;
            continue;
          }

          if (operator === 0xc8) {
            clut = command & 0xffff;
            continue;
          }

          if (primitiveOperator === 0x24) {
            const extraOffset = partOffset + context.displayListOffset;
            const uv = [
              [reader.u8(extraOffset), reader.u8(extraOffset + 1)],
              [reader.u8(extraOffset + 2), reader.u8(extraOffset + 3)],
              [command & 0xff, (command >> 8) & 0xff],
            ];
            context.displayListOffset += 4;
            const source = readPolygonVertices(reader, context, 3, hasNormal);
            const order = [0, 2, 1];
            const vertices = order.map((sourceIndex) => ({ ...source[sourceIndex], uv: uv[sourceIndex] }));
            const material = shaderBuilder.get(status, clut, semiTransparent, true, hasNormal);
            block.texturedTriangles.push({ material, vertices });
          } else if (primitiveOperator === 0x2c) {
            const extraOffset = partOffset + context.displayListOffset;
            const uv = [
              [reader.u8(extraOffset), reader.u8(extraOffset + 1)],
              [reader.u8(extraOffset + 2), reader.u8(extraOffset + 3)],
              [reader.u8(extraOffset + 4), reader.u8(extraOffset + 5)],
              [reader.u8(extraOffset + 6), reader.u8(extraOffset + 7)],
            ];
            context.displayListOffset += 8;
            const source = readPolygonVertices(reader, context, 4, hasNormal);
            const order = [1, 0, 2, 3];
            const vertices = order.map((sourceIndex) => ({ ...source[sourceIndex], uv: uv[sourceIndex] }));
            const material = shaderBuilder.get(status, clut, semiTransparent, true, hasNormal);
            block.texturedQuads.push({ material, vertices });
          } else if (primitiveOperator === 0x20) {
            const color = rgbaFromCommand(command, semiTransparent, status);
            const source = readPolygonVertices(reader, context, 3, hasNormal);
            const order = [0, 2, 1];
            const vertices = order.map((sourceIndex) => ({ ...source[sourceIndex], color }));
            const material = shaderBuilder.get(status, clut, semiTransparent, false, hasNormal);
            block.monochromeTriangles.push({ material, vertices });
          } else if (primitiveOperator === 0x28) {
            const color = rgbaFromCommand(command, semiTransparent, status);
            const source = readPolygonVertices(reader, context, 4, hasNormal);
            const order = [1, 0, 2, 3];
            const vertices = order.map((sourceIndex) => ({ ...source[sourceIndex], color }));
            const material = shaderBuilder.get(status, clut, semiTransparent, false, hasNormal);
            block.monochromeQuads.push({ material, vertices });
          } else {
            const details = {
              command: `0x${command.toString(16).padStart(8, '0')}`,
              commandOffset,
              partIndex,
              blockIndex,
              meshBlockIndex,
            };
            diagnostics.push({ severity: 'error', code: 'UNKNOWN_DISPLAY_COMMAND', ...details });
            throw new XenoFormatError('Unknown field display-list command', 'UNKNOWN_DISPLAY_COMMAND', details);
          }

          polygonsRemaining -= 1;
        }
      }

      blocks.push({
        ...block,
        source: { vertexCount, meshCount, meshBlockCount },
      });
    }

    parts.push({ blocks });
  }

  return {
    parts,
    materials: shaderBuilder.shaders,
    diagnostics,
  };
}
