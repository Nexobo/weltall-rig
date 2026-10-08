const TEXTURE_SIZE = 256;

function getGroup(groups, material, textured) {
  let group = groups.get(material);
  if (!group) {
    group = {
      material,
      textured,
      positions: [],
      normals: [],
      uvs: [],
      colors: [],
      indices: [],
      sourceFaceCorners: [[], [], [], []],
      deformations: [],
    };
    groups.set(material, group);
  }
  return group;
}

function appendVertex(group, vertex, corners) {
  const index = group.positions.length / 3;
  group.positions.push(vertex.position[0], vertex.position[1], vertex.position[2]);
  vertex.deformations?.forEach((offset, channel) => {
    group.deformations[channel] ??= [];
    group.deformations[channel].push(...offset);
  });
  group.normals.push(vertex.normal[0] / 4096, vertex.normal[1] / 4096, vertex.normal[2] / 4096);

  if (group.textured) {
    group.uvs.push((vertex.uv[0] + 0.5) / TEXTURE_SIZE, (vertex.uv[1] + 0.5) / TEXTURE_SIZE);
  } else {
    group.colors.push(vertex.color[0], vertex.color[1], vertex.color[2], vertex.color[3]);
  }

  group.indices.push(index);
  corners.forEach((corner, cornerIndex) => group.sourceFaceCorners[cornerIndex].push(...corner.position));
}

function appendPolygon(group, vertices) {
  // Keep the original polygon together after triangulation. Retail mode2 sorts
  // a quad by its farthest FOURTH corner too, even when that corner is not in
  // the rasterized triangle. Repeating a triangle's last corner preserves max.
  const corners = vertices.length === 3 ? [...vertices, vertices[2]] : vertices;
  if (vertices.length === 3) {
    vertices.forEach((vertex) => appendVertex(group, vertex, corners));
    return;
  }

  const triangleOrder = [0, 1, 2, 0, 2, 3];
  triangleOrder.forEach((index) => appendVertex(group, vertices[index], corners));
}

function normalizeBlock(block) {
  const groups = new Map();
  const sources = [
    [block.texturedTriangles, true],
    [block.texturedQuads, true],
    [block.monochromeTriangles, false],
    [block.monochromeQuads, false],
  ];

  for (const [polygons, textured] of sources) {
    for (const polygon of polygons) {
      appendPolygon(getGroup(groups, polygon.material, textured), polygon.vertices);
    }
  }

  return [...groups.values()].map((group) => ({
    material: group.material,
    positions: new Float32Array(group.positions),
    normals: new Float32Array(group.normals),
    uvs: group.textured ? new Float32Array(group.uvs) : null,
    colors: group.textured ? null : new Uint8Array(group.colors),
    indices: new Uint32Array(group.indices),
    sourceFaceCorners: group.sourceFaceCorners.map((corner) => new Float32Array(corner)),
    deformations: group.deformations.map(target => new Float32Array(target)),
  }));
}

export function normalizeFieldLevel({ discNumber, levelNumber, parsedModel, textures, nodes }) {
  const parts = parsedModel.parts.map((part) => ({
    primitives: part.blocks.flatMap(normalizeBlock),
  }));
  const modelNodes = nodes.filter((node) => (node.flags & 0x40) === 0);

  for (const [nodeIndex, node] of modelNodes.entries()) {
    if (node.part < 0 || node.part >= parts.length) {
      throw new RangeError(`Field model node ${nodeIndex} references missing part ${node.part}`);
    }
  }

  const meshCount = parts.reduce((count, part) => count + (part.primitives.length > 0 ? 1 : 0), 0);
  const primitiveCount = parts.reduce((count, part) => count + part.primitives.length, 0);
  const triangleCount = parts.reduce(
    (partTotal, part) => partTotal + part.primitives.reduce(
      (primitiveTotal, primitive) => primitiveTotal + primitive.indices.length / 3,
      0,
    ),
    0,
  );

  return {
    discNumber,
    levelNumber,
    parts,
    modelCollisions: parsedModel.parts.map(part => part.blocks[0]?.collision ?? null),
    nodes,
    materials: parsedModel.materials,
    textures,
    diagnostics: parsedModel.diagnostics,
    stats: {
      parts: parts.length,
      shaders: parsedModel.materials.length,
      nodes: nodes.length,
      meshes: meshCount,
      primitives: primitiveCount,
      triangles: triangleCount,
      textures: textures.filter(Boolean).length,
    },
  };
}
