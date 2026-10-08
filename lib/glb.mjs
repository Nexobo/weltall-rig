import assert from 'node:assert/strict';
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';

export function readGlb(bytes) {
  assert(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67, 'Expected a GLB file');
  assert(bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length, 'Invalid GLB header');
  let json, bin = Buffer.alloc(0);
  for (let offset = 12; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert(size % 4 === 0 && offset + 8 + size <= bytes.length, 'Invalid GLB chunk');
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (type === 0x4e4f534a) { assert(!json, 'Duplicate JSON chunk'); json = JSON.parse(chunk.toString()); }
    else if (type === 0x004e4942) { assert(!bin.length, 'Duplicate binary chunk'); bin = chunk; }
    else throw Error('Unsupported GLB chunk');
    offset += 8 + size;
  }
  assert(json?.asset?.version === '2.0', 'Expected glTF 2.0');
  assert(json.buffers?.length === 1 && !json.buffers[0].uri, 'GLB must contain one embedded buffer');
  assert(json.buffers[0].byteLength <= bin.length, 'Truncated GLB buffer');
  for (const image of json.images ?? []) assert(!image.uri && Number.isInteger(image.bufferView), 'Textures must be embedded');
  for (const ext of json.extensionsUsed ?? []) assert(ext === 'KHR_materials_unlit', `Unsupported extension: ${ext}`);
  return { json, bin };
}

export function writeGlb({ json, bin }) {
  const raw = Buffer.from(JSON.stringify(json));
  const text = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32); raw.copy(text);
  const binary = Buffer.alloc(Math.ceil(bin.length / 4) * 4); bin.copy(binary);
  const result = Buffer.alloc(28 + text.length + binary.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(text.length, 12); result.writeUInt32LE(0x4e4f534a, 16); text.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + text.length); result.writeUInt32LE(0x004e4942, 24 + text.length);
  binary.copy(result, 28 + text.length);
  return result;
}

function matrix(n) {
  if (n.matrix) return n.matrix;
  const [x,y,z,w] = n.rotation ?? [0,0,0,1], [a,b,c] = n.scale ?? [1,1,1];
  const [tx,ty,tz] = n.translation ?? [0,0,0];
  return [(1-2*y*y-2*z*z)*a,(2*x*y+2*w*z)*a,(2*x*z-2*w*y)*a,0,
    (2*x*y-2*w*z)*b,(1-2*x*x-2*z*z)*b,(2*y*z+2*w*x)*b,0,
    (2*x*z+2*w*y)*c,(2*y*z-2*w*x)*c,(1-2*x*x-2*y*y)*c,0,tx,ty,tz,1];
}

function nodesByName(json) {
  assert(json.scenes?.length === 1 && (json.scene ?? 0) === 0, 'Expected exactly one scene');
  const names = new Map(), parents = new Map(), reached = new Set();
  for (const [index,n] of (json.nodes ?? []).entries()) {
    assert(n.name && !names.has(n.name), `Missing or duplicate node name: ${n.name}`);
    assert(n.skin === undefined && n.weights === undefined && n.camera === undefined && !n.extensions, `Unsupported node properties: ${n.name}`);
    names.set(n.name, { node: n, index });
    for (const child of n.children ?? []) {
      assert(json.nodes[child] && !parents.has(child), 'Invalid or shared child node'); parents.set(child,index);
    }
  }
  function visit(i) { assert(json.nodes[i] && !reached.has(i), 'Invalid scene hierarchy'); reached.add(i); for(const c of json.nodes[i].children ?? []) visit(c); }
  for(const i of json.scenes[0].nodes ?? []) { assert(!parents.has(i), 'Scene root has a parent'); visit(i); }
  assert(reached.size === names.size, 'Detached nodes are not allowed');
  for(const entry of names.values()) entry.parent = parents.has(entry.index) ? json.nodes[parents.get(entry.index)].name : null;
  return names;
}

// Original field 190 helper meshes, attached by FEC5 to native Id wing bones.
const ID_HOLO_WINGS = new Map([
  [49,13,8], [50,11,7], [51,9,6], [52,10,7], [53,8,6], [54,12,8],
].map(([joint,sourceFieldNode,sourcePart]) => [`Id_Holo_Wing_${String(joint).padStart(3,'0')}`,
  {joint,sourceFieldNode,sourcePart}]));
const ID_HOLO_MATERIAL = {name:'Id_Holo_Wings',extras:{psxStatus:7,psxClut:30848,
  psxTextured:true,psxSemiTransparent:true,psxBlendMode:0,psxHasVertexNormals:false,
  sourceField:190,sourceMaterial:9}};

export async function validateEdited(originalBytes, editedBytes) {
  const original = readGlb(originalBytes), edited = readGlb(editedBytes);
  const before = nodesByName(original.json), after = nodesByName(edited.json);
  for(const name of before.keys()) assert(after.has(name), `Missing/renamed node: ${name}`);
  const handVariants = new Map(), holoWings = new Map();
  for(const [name, entry] of after) if(!before.has(name)) {
    const wing = ID_HOLO_WINGS.get(name);
    if(wing) {
      const extra = entry.node.extras;
      assert(original.json.scenes[0].name === 'Xenogears Disc 1 Scene Model 38' &&
        extra?.custom_id_holo_wing === 1 && extra.sourceField === 190 &&
        extra.sourceFieldNode === wing.sourceFieldNode && extra.sourcePart === wing.sourcePart &&
        extra.sourceNodeIndex === wing.joint && extra.transformRole === 'mesh-visibility-carrier' &&
        !entry.node.children?.length && entry.node.mesh !== undefined &&
        entry.parent === `Bone_${String(wing.joint).padStart(3,'0')}` && before.has(entry.parent),
        `Invalid original Id holographic wing attachment: ${name}`);
      const local = matrix(entry.node), identity = matrix({});
      assert(local.every((v,i) => Number.isFinite(v) && Math.abs(v-identity[i]) <= (i >= 12 && i <= 14 ? 0.002 : 1e-5)),
        `Holographic wing rest transform must be identity: ${name}`);
      holoWings.set(name,wing);
      continue;
    }
    const side = name === 'Id_Hand_Closed.L' ? 'L' : name === 'Id_Hand_Closed.R' ? 'R' : null;
    const joint = side === 'L' ? 18 : 10, counterpart = `Bone_${String(joint).padStart(3,'0')}_Display`;
    const extra = entry.node.extras;
    assert(side && original.json.scenes[0].name === 'Xenogears Disc 1 Scene Model 38' &&
      extra?.custom_id_hand_variant === 1 && extra.handSide === side && extra.handState === 'closed' &&
      extra.originalDisplayName === counterpart && extra.sourceNodeIndex === joint &&
      extra.transformRole === 'mesh-visibility-carrier' && !entry.node.children?.length &&
      entry.node.mesh !== undefined && entry.parent === `Bone_${String(joint).padStart(3,'0')}` &&
      before.get(counterpart)?.parent === entry.parent,
      'Node count changed: only the two approved Id hand variant mesh leaves may be added');
    handVariants.set(name, counterpart);
  }
  assert(!holoWings.size || holoWings.size === 6, 'All six original Id holographic wings must be retained');
  assert(before.size + handVariants.size + holoWings.size === after.size, 'Node count changed: do not add/delete parts or hierarchy nodes');
  for(const [name,a] of before) {
    const b = after.get(name); assert(b, `Missing/renamed node: ${name}`);
    assert(a.parent === b.parent, `Parent changed: ${name}`);
    assert((a.node.mesh !== undefined) === (b.node.mesh !== undefined), `Mesh attachment changed: ${name}`);
    const am = matrix(a.node), bm = matrix(b.node);
    assert(am.length === 16 && bm.length === 16 && am.every((v,i) => Number.isFinite(bm[i]) && Math.abs(v-bm[i]) <= (i >= 12 && i <= 14 ? 0.002 : 1e-5 * Math.max(1, Math.abs(v)))), `Rest transform/pivot changed: ${name}`);
  }
  for(const [name, counterpart] of handVariants) {
    const node = after.get(name).node;
    assert(node.scale?.length === 3 && node.scale.every(v => v === 0) && !node.matrix, `Hand variant must start hidden: ${name}`);
    const am = matrix(after.get(counterpart).node), bm = matrix({...node,scale:[1,1,1]});
    assert(am.every((v,i) => Number.isFinite(bm[i]) && Math.abs(v-bm[i]) <= 1e-5), `Hand variant rest transform/pivot changed: ${name}`);
  }
  const originalMaterials = new Map((original.json.materials ?? []).map(m => [m.name,m]));
  const sourceMaterials = new Map(originalMaterials);
  if(holoWings.size) sourceMaterials.set(ID_HOLO_MATERIAL.name,ID_HOLO_MATERIAL);
  const seenMaterials = new Set();
  for(const m of edited.json.materials ?? []) {
    assert(sourceMaterials.has(m.name) && !seenMaterials.has(m.name), `Unknown/duplicate material: ${m.name}`);
    if(m.name === ID_HOLO_MATERIAL.name) {
      assert(Object.entries(ID_HOLO_MATERIAL.extras).every(([key,value]) => m.extras?.[key] === value) &&
        m.alphaMode === 'BLEND' && m.extensions?.KHR_materials_unlit &&
        m.pbrMetallicRoughness?.baseColorTexture, 'Missing original Id holographic wing material/texture');
    }
    seenMaterials.add(m.name);
  }
  const meshSources = new Map([...before, ...[...handVariants].map(([name, counterpart]) => [name, before.get(counterpart)]),
    ...[...holoWings.keys()].map(name => [name,after.get(name)])]);
  for(const [name,a] of meshSources) {
    if(a.node.mesh === undefined) continue;
    const allowed = holoWings.has(name) ? new Set([ID_HOLO_MATERIAL.name]) :
      new Set(original.json.meshes[a.node.mesh].primitives.map(p => original.json.materials[p.material].name));
    const mesh = edited.json.meshes?.[after.get(name).node.mesh];
    assert(mesh?.primitives?.length && !mesh.weights, `Missing/unsupported mesh: ${name}`);
    for(const p of mesh.primitives) {
      assert((p.mode ?? 4) === 4 && !p.targets && !p.extensions, `Only rigid triangle meshes are supported: ${name}`);
      assert(p.attributes?.POSITION !== undefined, `Missing vertices: ${name}`);
      assert(!Object.keys(p.attributes).some(k => /^(JOINTS|WEIGHTS)_/.test(k)), `Skinning is not supported: ${name}`);
      const material = edited.json.materials?.[p.material];
      assert(material && allowed.has(material.name), `Material moved to a different part: ${name}`);
      if(holoWings.has(name) || originalMaterials.get(material.name).pbrMetallicRoughness?.baseColorTexture) {
        assert(material.pbrMetallicRoughness?.baseColorTexture, `Missing texture: ${material.name}`);
        assert(p.attributes.TEXCOORD_0 !== undefined, `Missing UVs: ${name}`);
      }
    }
  }
  // Decode the actual accessors, not just JSON metadata, before accepting geometry.
  const doc = await new NodeIO().registerExtensions([KHRMaterialsUnlit]).readBinary(editedBytes);
  for(const a of doc.getRoot().listAccessors()) assert(a.getArray() && a.getArray().every(Number.isFinite), 'Invalid/non-finite accessor values');
  for(const mesh of doc.getRoot().listMeshes()) for(const p of mesh.listPrimitives()) {
    const positions = p.getAttribute('POSITION'); assert(positions?.getCount() > 0, 'Empty mesh');
    for(const semantic of p.listSemantics()) assert(p.getAttribute(semantic).getCount() === positions.getCount(), `Attribute count mismatch: ${semantic}`);
    const indices = p.getIndices();
    assert((indices?.getCount() ?? positions.getCount()) % 3 === 0, 'Incomplete triangle');
    if(indices) assert(indices.getArray().every(i => i >= 0 && Number.isInteger(i) && i < positions.getCount()), 'Mesh index out of range');
  }
  const animationNames = new Set();
  for(const animation of edited.json.animations ?? []) {
    assert(animation.name && !animationNames.has(animation.name), 'Missing/duplicate animation name');
    animationNames.add(animation.name);
    assert(animation.channels?.length && animation.samplers?.length, 'Empty animation');
    const targets = new Set();
    for(const channel of animation.channels) {
      const target = channel.target, sampler = animation.samplers[channel.sampler];
      assert(edited.json.nodes[target?.node] && ['translation','rotation','scale'].includes(target.path), 'Invalid animation target');
      const key = `${target.node}/${target.path}`;
      assert(!targets.has(key), 'Duplicate animation channel'); targets.add(key);
      assert(sampler && ['LINEAR','STEP'].includes(sampler.interpolation ?? 'LINEAR'), 'Unsupported animation interpolation');
      const input = edited.json.accessors[sampler.input], output = edited.json.accessors[sampler.output];
      assert(input?.type === 'SCALAR' && input.componentType === 5126 && input.count > 0 &&
        output?.type === (target.path === 'rotation' ? 'VEC4' : 'VEC3') &&
        output.componentType === 5126 && output.count === input.count, 'Invalid animation sample layout');
      const view = edited.json.bufferViews[input.bufferView];
      assert(view && !input.sparse, 'Unsupported animation time accessor');
      let previous = -1;
      for(let i = 0; i < input.count; i++) {
        const time = edited.bin.readFloatLE((view.byteOffset ?? 0) + (input.byteOffset ?? 0) + i * (view.byteStride ?? 4));
        assert(Number.isFinite(time) && time >= 0 && time > previous, 'Animation times must be finite, nonnegative and increasing');
        previous = time;
      }
    }
  }
  return { original, edited, before, after, sourceMaterials, handVariants, holoWings };
}

// Keep original nodes/buffers, append edited assets, and merge named baked clips.
export async function importEdited(originalBytes, editedBytes) {
  const { original, edited, before, after, sourceMaterials, handVariants, holoWings } = await validateEdited(originalBytes, editedBytes);
  const j = structuredClone(original.json), e = structuredClone(edited.json);
  const offsets = Object.fromEntries(['bufferViews','accessors','images','samplers','textures','materials','meshes'].map(k => [k, j[k]?.length ?? 0]));
  const shift = (value,key) => value === undefined ? undefined : value + offsets[key];
  for(const v of e.bufferViews ?? []) { assert(v.buffer === 0, 'Invalid buffer reference'); v.byteOffset = (v.byteOffset ?? 0) + original.bin.length; }
  for(const a of e.accessors ?? []) {
    if(a.bufferView !== undefined) a.bufferView += offsets.bufferViews;
    if(a.sparse) { a.sparse.indices.bufferView += offsets.bufferViews; a.sparse.values.bufferView += offsets.bufferViews; }
  }
  for(const image of e.images ?? []) image.bufferView += offsets.bufferViews;
  for(const texture of e.textures ?? []) { texture.source = shift(texture.source,'images'); texture.sampler = shift(texture.sampler,'samplers'); }
  for(const material of e.materials ?? []) {
    for(const info of [material.pbrMetallicRoughness?.baseColorTexture, material.pbrMetallicRoughness?.metallicRoughnessTexture, material.normalTexture, material.occlusionTexture, material.emissiveTexture]) if(info) info.index += offsets.textures;
    material.extras = structuredClone(sourceMaterials.get(material.name).extras ?? {});
  }
  for(const mesh of e.meshes ?? []) for(const p of mesh.primitives) {
    for(const semantic of Object.keys(p.attributes)) p.attributes[semantic] += offsets.accessors;
    p.indices = shift(p.indices,'accessors'); p.material = shift(p.material,'materials');
  }
  for(const key of Object.keys(offsets)) j[key] = [...(j[key] ?? []), ...(e[key] ?? [])];
  for(const [name,a] of before) if(a.node.mesh !== undefined) j.nodes[a.index].mesh = after.get(name).node.mesh + offsets.meshes;
  const nodeIndices = new Map([...before].map(([name,entry]) => [name,entry.index]));
  for(const name of [...handVariants.keys(),...holoWings.keys()]) {
    const entry = after.get(name), index = j.nodes.length;
    nodeIndices.set(name,index);
    const node = {...e.nodes[entry.index], mesh:e.nodes[entry.index].mesh + offsets.meshes};
    if(handVariants.has(name)) node.scale = [0,0,0];
    j.nodes.push(node);
    (j.nodes[nodeIndices.get(entry.parent)].children ??= []).push(index);
  }
  if(e.animations?.length) {
    const animations = new Map((j.animations ?? []).map(a => [a.name,a]));
    for(const animation of e.animations) {
      for(const sampler of animation.samplers) {
        sampler.input += offsets.accessors;
        sampler.output += offsets.accessors;
      }
      for(const channel of animation.channels) channel.target.node = nodeIndices.get(e.nodes[channel.target.node].name);
      animations.set(animation.name,animation);
    }
    j.animations = [...animations.values()];
  }
  j.extensionsUsed = [...new Set([...(j.extensionsUsed ?? []), ...(e.extensionsUsed ?? [])])];
  const bin = Buffer.concat([original.bin,edited.bin]); j.buffers[0].byteLength = bin.length;
  return writeGlb({json:j,bin});
}
