import fs from 'node:fs';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import pngjs from 'pngjs';
import { SCENE_MODEL_CACHE_VERSION } from './scene-model-metrics.js';

const { PNG } = pngjs;
const NEAREST = 9728;

function multiplyQuaternion(left, right) {
  const [ax, ay, az, aw] = left;
  const [bx, by, bz, bw] = right;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotationQuaternion(rotation) {
  const halfX = rotation[0] * Math.PI / 4096;
  const halfY = rotation[1] * Math.PI / 4096;
  const halfZ = rotation[2] * Math.PI / 4096;
  const x = [Math.sin(halfX), 0, 0, Math.cos(halfX)];
  const y = [0, Math.sin(halfY), 0, Math.cos(halfY)];
  const z = [0, 0, Math.sin(halfZ), Math.cos(halfZ)];
  return multiplyQuaternion(multiplyQuaternion(x, y), z);
}

function rootRotationQuaternion(rotation) {
  const halfX = rotation[0] * Math.PI / 4096;
  const halfY = rotation[1] * Math.PI / 4096;
  const halfZ = rotation[2] * Math.PI / 4096;
  const x = [Math.sin(halfX), 0, 0, Math.cos(halfX)];
  const y = [0, Math.sin(halfY), 0, Math.cos(halfY)];
  const z = [0, 0, Math.sin(halfZ), Math.cos(halfZ)];
  return multiplyQuaternion(multiplyQuaternion(y, x), z);
}

function createAccessor(document, buffer, name, type, array, normalized = false) {
  return document.createAccessor(name)
    .setType(type)
    .setArray(array)
    .setBuffer(buffer)
    .setNormalized(normalized);
}

function encodePng(texture) {
  return PNG.sync.write({
    width: texture.width,
    height: texture.height,
    data: Buffer.from(texture.rgba.buffer, texture.rgba.byteOffset, texture.rgba.byteLength),
  });
}

function createMaterials(document, sceneModel) {
  const unlitExtension = document.createExtension(KHRMaterialsUnlit);

  return sceneModel.materials.map((source, materialIndex) => {
    const material = document.createMaterial(`Material_${materialIndex.toString().padStart(3, '0')}`)
      .setBaseColorFactor([1, 1, 1, 1])
      .setMetallicFactor(0)
      .setRoughnessFactor(1)
      .setDoubleSided(true)
      .setExtension('KHR_materials_unlit', unlitExtension.createUnlit())
      .setExtras({
        psxStatus: source.status,
        psxClut: source.clut,
        psxTextured: source.textured,
        psxSemiTransparent: source.semiTransparent,
        psxBlendMode: source.blendMode,
        ...(source.hasVertexNormals !== undefined ? { psxHasVertexNormals: source.hasVertexNormals } : {}),
      });

    if (source.semiTransparent) {
      material.setAlphaMode('BLEND');
    } else if (source.textured) {
      material.setAlphaMode('MASK').setAlphaCutoff(0.01);
    }

    const sourceTexture = sceneModel.textures[materialIndex];
    if (sourceTexture) {
      const texture = document.createTexture(`Texture_${materialIndex.toString().padStart(3, '0')}`)
        .setImage(encodePng(sourceTexture))
        .setMimeType('image/png');
      material.setBaseColorTexture(texture);
      material.getBaseColorTextureInfo().setMagFilter(NEAREST).setMinFilter(NEAREST);
    }

    return material;
  });
}

function createMeshes(document, buffer, sceneModel, materials) {
  return sceneModel.parts.map((part, partIndex) => {
    if (part.primitives.length === 0) {
      return null;
    }

    const mesh = document.createMesh(`Part_${partIndex.toString().padStart(3, '0')}`);
    part.primitives.forEach((source, primitiveIndex) => {
      const prefix = `Part_${partIndex}_Primitive_${primitiveIndex}`;
      const primitive = document.createPrimitive()
        .setMaterial(materials[source.material])
        .setAttribute('POSITION', createAccessor(document, buffer, `${prefix}_POSITION`, 'VEC3', source.positions))
        .setAttribute('NORMAL', createAccessor(document, buffer, `${prefix}_NORMAL`, 'VEC3', source.normals))
        .setIndices(createAccessor(document, buffer, `${prefix}_INDICES`, 'SCALAR', source.indices));

      if (source.uvs) {
        primitive.setAttribute('TEXCOORD_0', createAccessor(document, buffer, `${prefix}_TEXCOORD_0`, 'VEC2', source.uvs));
      }
      if (source.colors) {
        primitive.setAttribute('COLOR_0', createAccessor(
          document,
          buffer,
          `${prefix}_COLOR_0`,
          'VEC4',
          source.colors,
          true,
        ));
      }
      mesh.addPrimitive(primitive);
    });
    return mesh;
  });
}

function sameValue(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function frameValue(frame, nodeIndex, pathName) {
  if (pathName === 'rotation') return frame.rotations[nodeIndex];
  if (pathName === 'translation') return frame.translations[nodeIndex];
  return frame.scales[nodeIndex];
}

function trackNeeded(frames, nodeIndex, pathName, defaultValue) {
  return frames.some((frame) => !sameValue(frameValue(frame, nodeIndex, pathName), defaultValue));
}

function rotationTrack(frames, nodeIndex) {
  const output = new Float32Array(frames.length * 4);
  let previous = null;
  frames.forEach((frame, frameIndex) => {
    let quaternion = rotationQuaternion(frame.rotations[nodeIndex]);
    if (previous && quaternion.reduce((dot, value, index) => dot + value * previous[index], 0) < 0) {
      quaternion = quaternion.map((value) => -value);
    }
    output.set(quaternion, frameIndex * 4);
    previous = quaternion;
  });
  return output;
}

function vectorTrack(frames, nodeIndex, pathName) {
  const output = new Float32Array(frames.length * 3);
  frames.forEach((frame, frameIndex) => {
    output.set(frameValue(frame, nodeIndex, pathName), frameIndex * 3);
  });
  return output;
}

function addAnimationChannel(
  document,
  buffer,
  animation,
  input,
  node,
  clip,
  nodeIndex,
  pathName,
  interpolation = 'LINEAR',
) {
  const output = createAccessor(
    document,
    buffer,
    `${clip.name}_Bone_${nodeIndex}_${pathName}`,
    pathName === 'rotation' ? 'VEC4' : 'VEC3',
    pathName === 'rotation'
      ? rotationTrack(clip.frames, nodeIndex)
      : vectorTrack(clip.frames, nodeIndex, pathName),
  );
  const sampler = document.createAnimationSampler(`${clip.name}_Bone_${nodeIndex}_${pathName}`)
    .setInput(input)
    .setOutput(output)
    .setInterpolation(interpolation);
  const channel = document.createAnimationChannel(`${clip.name}_Bone_${nodeIndex}_${pathName}`)
    .setSampler(sampler)
    .setTargetNode(node)
    .setTargetPath(pathName);
  animation.addSampler(sampler).addChannel(channel);
}

function rootFrameValue(frame, pathName) {
  if (pathName === 'rotation') return frame.rootRotation || [0, 0, 0];
  if (pathName === 'translation') return frame.rootTranslation || [0, 0, 0];
  return frame.rootScale || [1, 1, 1];
}

function rootTrack(frames, pathName) {
  const itemSize = pathName === 'rotation' ? 4 : 3;
  const output = new Float32Array(frames.length * itemSize);
  let previous = null;
  frames.forEach((frame, frameIndex) => {
    let value = rootFrameValue(frame, pathName);
    if (pathName === 'rotation') {
      value = rootRotationQuaternion(value);
      if (previous && value.reduce((dot, component, index) => dot + component * previous[index], 0) < 0) {
        value = value.map((component) => -component);
      }
      previous = value;
    }
    output.set(value, frameIndex * itemSize);
  });
  return output;
}

function addRootAnimationChannel(
  document,
  buffer,
  animation,
  input,
  instanceRoot,
  clip,
  pathName,
) {
  const output = createAccessor(
    document,
    buffer,
    `${clip.name}_Root_${pathName}`,
    pathName === 'rotation' ? 'VEC4' : 'VEC3',
    rootTrack(clip.frames, pathName),
  );
  const sampler = document.createAnimationSampler(`${clip.name}_Root_${pathName}`)
    .setInput(input)
    .setOutput(output)
    .setInterpolation('LINEAR');
  const channel = document.createAnimationChannel(`${clip.name}_Root_${pathName}`)
    .setSampler(sampler)
    .setTargetNode(instanceRoot)
    .setTargetPath(pathName);
  animation.addSampler(sampler).addChannel(channel);
}

function visibilityTrack(frames, nodeIndex) {
  const output = new Float32Array(frames.length * 3);
  frames.forEach((frame, frameIndex) => {
    const value = frame.visible[nodeIndex] ? 1 : 0;
    output.set([value, value, value], frameIndex * 3);
  });
  return output;
}

function addVisibilityChannel(document, buffer, animation, input, displayNode, clip, nodeIndex) {
  const output = createAccessor(
    document,
    buffer,
    `${clip.name}_Bone_${nodeIndex}_visibility`,
    'VEC3',
    visibilityTrack(clip.frames, nodeIndex),
  );
  const sampler = document.createAnimationSampler(`${clip.name}_Bone_${nodeIndex}_visibility`)
    .setInput(input)
    .setOutput(output)
    .setInterpolation('STEP');
  const channel = document.createAnimationChannel(`${clip.name}_Bone_${nodeIndex}_visibility`)
    .setSampler(sampler)
    .setTargetNode(displayNode)
    .setTargetPath('scale');
  animation.addSampler(sampler).addChannel(channel);
}

function animationStatus(clip) {
  if (!['complete', 'context-required', 'unknown'].includes(clip.status)) {
    throw new Error(`Scene-model animation ${clip.index} has no normalized status.`);
  }
  return clip.status;
}

function createAnimations(
  document,
  buffer,
  sceneModel,
  nodes,
  displayNodes,
  instanceRoot,
) {
  return (sceneModel.animations || []).map((clip) => {
    const status = animationStatus(clip);
    const animation = document.createAnimation(clip.name).setExtras({
      sourceIndex: clip.index,
      fps: clip.fps,
      ticks: clip.ticks,
      loop: clip.loop,
      status,
      complete: status === 'complete',
      unsupportedOpcodes: clip.unsupportedOpcodes || [],
      unsupportedTrackModes: clip.unsupportedTrackModes || [],
      unsupportedKeyframes: clip.unsupportedKeyframes || [],
      runtimeDependencies: clip.runtimeDependencies || [],
      scriptErrors: clip.scriptErrors || [],
      events: clip.events || [],
    });
    const input = createAccessor(
      document,
      buffer,
      `${clip.name}_Time`,
      'SCALAR',
      new Float32Array(clip.frames.map((frame) => frame.tick / clip.fps)),
    );
    let channelCount = 0;

    for (const pathName of ['rotation', 'translation', 'scale']) {
      const defaultValue = pathName === 'scale' ? [1, 1, 1] : [0, 0, 0];
      if (!clip.frames.some((frame) => (
        !sameValue(rootFrameValue(frame, pathName), defaultValue)
      ))) continue;
      addRootAnimationChannel(
        document,
        buffer,
        animation,
        input,
        instanceRoot,
        clip,
        pathName,
      );
      channelCount += 1;
    }

    nodes.forEach((node, nodeIndex) => {
      for (const pathName of ['rotation', 'translation', 'scale']) {
        const defaultValue = pathName === 'rotation'
          ? sceneModel.nodes[nodeIndex].rotation
          : pathName === 'translation'
            ? sceneModel.nodes[nodeIndex].translation
            : [1, 1, 1];
        if (!trackNeeded(clip.frames, nodeIndex, pathName, defaultValue)) continue;
        addAnimationChannel(document, buffer, animation, input, node, clip, nodeIndex, pathName);
        channelCount += 1;
      }
      if (displayNodes[nodeIndex] && clip.frames.some((frame) => !frame.visible[nodeIndex])) {
        addVisibilityChannel(document, buffer, animation, input, displayNodes[nodeIndex], clip, nodeIndex);
        channelCount += 1;
      }
    });

    // Keep pose-only scripts visible to Three.js as real selectable clips.
    if (channelCount === 0 && nodes.length > 0) {
      addAnimationChannel(document, buffer, animation, input, nodes[0], clip, 0, 'rotation');
    }
    return animation;
  });
}

export async function createSceneModelGlb(sceneModel) {
  const document = new Document();
  const buffer = document.createBuffer('SceneModelBuffer');
  const scene = document.createScene(
    `Xenogears Disc ${sceneModel.discNumber} Scene Model ${sceneModel.sceneModelNumber}`,
  );
  const metersPerEngineUnit = sceneModel.measurements.scale.metersPerEngineUnit;
  const embeddedScaleFactor = sceneModel.measurements.scale.embeddedFactor;
  const axisRoot = document.createNode('Xenogears coordinate conversion')
    .setRotation([1, 0, 0, 0])
    .setScale([metersPerEngineUnit, metersPerEngineUnit, metersPerEngineUnit])
    .setExtras({
      transformRole: 'axis-and-engine-unit-conversion',
      metersPerEngineUnit,
  });
  scene.addChild(axisRoot);
  const instanceRoot = document.createNode('Scene model instance root').setExtras({
    transformRole: 'external-placement',
    coordinateUnit: 'engine-unit',
  });
  const modelScaleRoot = document.createNode('Scene model embedded scale')
    .setScale([embeddedScaleFactor, embeddedScaleFactor, embeddedScaleFactor])
    .setExtras({
      transformRole: 'embedded-model-scale',
      embeddedScale: sceneModel.modelConfig.embeddedScale,
      fixedDivisor: sceneModel.measurements.scale.fixedDivisor,
    });
  axisRoot.addChild(instanceRoot);
  instanceRoot.addChild(modelScaleRoot);
  document.getRoot().setExtras({
    source: 'Xenogears Map Viewer',
    assetType: 'scene-model',
    discNumber: sceneModel.discNumber,
    sceneModelNumber: sceneModel.sceneModelNumber,
    sceneModelCacheVersion: SCENE_MODEL_CACHE_VERSION,
    modelConfig: sceneModel.modelConfig,
    measurements: sceneModel.measurements,
    diagnostics: sceneModel.diagnostics,
  });

  const materials = createMaterials(document, sceneModel);
  const meshes = createMeshes(document, buffer, sceneModel, materials);
  const displayNodes = [];
  const nodes = sceneModel.nodes.map((source, nodeIndex) => {
    const node = document.createNode(`Bone_${nodeIndex.toString().padStart(3, '0')}`)
      .setTranslation(source.translation)
      .setRotation(rotationQuaternion(source.rotation))
      .setExtras({
        sourceNodeIndex: nodeIndex,
        parent: source.parent,
        part: source.part,
        transformRole: 'model-local-bone',
        rawTranslation: source.translation,
        rawRotation: source.rotation,
      });
    if (source.part >= 0 && meshes[source.part]) {
      const displayNode = document.createNode(`Bone_${nodeIndex.toString().padStart(3, '0')}_Display`)
        .setMesh(meshes[source.part])
        .setExtras({
          sourceNodeIndex: nodeIndex,
          transformRole: 'mesh-visibility-carrier',
        });
      node.addChild(displayNode);
      displayNodes[nodeIndex] = displayNode;
    }
    return node;
  });

  sceneModel.nodes.forEach((source, nodeIndex) => {
    if (source.parent < 0) {
      modelScaleRoot.addChild(nodes[nodeIndex]);
    } else {
      nodes[source.parent].addChild(nodes[nodeIndex]);
    }
  });

  const animations = createAnimations(
    document,
    buffer,
    sceneModel,
    nodes,
    displayNodes,
    instanceRoot,
  );
  const animationStatuses = (sceneModel.animations || []).map((clip) => {
    const status = animationStatus(clip);
    return {
      sourceIndex: clip.index,
      name: clip.name,
      status,
      complete: status === 'complete',
      loop: clip.loop,
      runtimeDependencies: clip.runtimeDependencies || [],
      unsupportedOpcodes: clip.unsupportedOpcodes || [],
      unsupportedTrackModes: clip.unsupportedTrackModes || [],
      unsupportedKeyframes: clip.unsupportedKeyframes || [],
      scriptErrors: clip.scriptErrors || [],
    };
  });
  const animationStatusCounts = Object.fromEntries(
    ['complete', 'context-required', 'unknown'].map((status) => [
      status,
      animationStatuses.filter((entry) => entry.status === status).length,
    ]),
  );
  document.getRoot().setExtras({
    ...document.getRoot().getExtras(),
    animationCount: animations.length,
    partialAnimationCount: animations.length - animationStatusCounts.complete,
    animationStatusCounts,
    animationStatuses,
  });

  return new NodeIO().registerExtensions([KHRMaterialsUnlit]).writeBinary(document);
}

export async function writeSceneModelGlb(sceneModel, outputPath) {
  const bytes = await createSceneModelGlb(sceneModel);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);
  return { outputPath: path.resolve(outputPath), bytes: bytes.byteLength };
}

export function getSceneModelGlbOutputPath(cacheDir, discNumber, modelNumber) {
  const modelName = `scene-model-${modelNumber.toString().padStart(4, '0')}`;
  return path.join(cacheDir, `disc-${discNumber}`, modelName, `${modelName}.glb`);
}
