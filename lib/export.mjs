import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { decodeSceneModel } from '../vendor/server/src/xeno/scene-model.js';
import { createSceneModelGlb } from '../vendor/server/src/xeno/scene-model-glb.js';
import { catalog, approvedSources } from './catalog.mjs';
import { mergeAnimations } from './merge.mjs';
import { weltallReferences } from './weltall-reference.mjs';
import { readGlb, writeGlb } from './glb.mjs';

export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const jsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function sourceBytes(sourceDir, index, expected) {
  const record = index.files.find(f => f.id === expected.id);
  assert(record?.workspacePath, `Missing approved source: ${expected.id}`);
  const root = path.resolve(sourceDir), file = path.resolve(root, record.workspacePath);
  const relative = path.relative(root,file);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Source path escapes source folder');
  const bytes = fs.readFileSync(file);
  assert(hash(bytes) === expected.sha256, `Source checksum mismatch: ${expected.id}`);
  return bytes;
}

export function writePackage(out, files) {
  assert(!fs.existsSync(out), `Output already exists: ${out}`);
  fs.mkdirSync(out, {recursive:true});
  for(const [name,bytes] of Object.entries(files)) fs.writeFileSync(path.join(out,name),bytes);
}

export async function exportModel(model, sourceDir, out, prepared) {
  assert(model.id==='weltall', 'This tool exports only Weltall');
  const index = jsonFile(path.join(sourceDir,'source-index.json'));
  assert(index.source.discNumber === 1, 'Approved catalog uses Disc 1');
  const sourceFiles = {}, sources = model.sources.map(id => {
    const source = approvedSources.find(s=>s.id===id);
    const modelBytes = sourceBytes(sourceDir,index,source.model), animationBytes = sourceBytes(sourceDir,index,source.animation);
    sourceFiles[id+'.model.bin'] = modelBytes;
    sourceFiles[id+'.animation.bin'] = animationBytes;
    const scene = decodeSceneModel({modelBuffer:modelBytes,animationBuffer:animationBytes,discNumber:1,modelNumber:source.modelNumber});
    return {id,scene};
  });
  const primary = sources.find(s=>s.id===model.primary).scene;
  const {animations,clips} = mergeAnimations(primary,sources);
  const glb = Buffer.from(await createSceneModelGlb({...primary,animations}));
  const edit = readGlb(glb); delete edit.json.animations;
  const manifest = {version:2,model,originalGlbSha256:hash(glb),clips,
    exportedClips:animations.map(c=>c.name),
    omittedClips:clips.filter(c=>c.omittedReason).map(c=>({name:c.name,reason:c.omittedReason})),
    sources:model.sources.map(id=>approvedSources.find(s=>s.id===id)),
    policy:'One canonical model. Edit meshes/UVs/textures only; original hierarchy and merged animation tracks are retained.'};
  const referenceFiles = {};
  if(model.id==='weltall') {
    const reference = weltallReferences(primary,sources,prepared);
    const referenceGlb = Buffer.from(await createSceneModelGlb({...primary,animations:reference.animations}));
    manifest.reference = {file:'reference.glb',sha256:hash(referenceGlb),clips:reference.animations.map(c=>c.name),
      sourceGaps:reference.report.sourceGaps,coverageFile:'animation-reference.json'};
    referenceFiles['reference.glb'] = referenceGlb;
    referenceFiles['animation-reference.json'] = JSON.stringify(reference.report,null,2)+'\n';
  }
  writePackage(out,{...referenceFiles,'model.glb':glb,'edit.glb':writeGlb(edit),'model.json':JSON.stringify(manifest,null,2)+'\n',...sourceFiles});
  return {model:model.id,parts:primary.parts.length,previewClips:manifest.reference?.clips.length ?? animations.length,omittedClips:manifest.reference ? 0 : manifest.omittedClips.length,partialReferenceClips:manifest.reference?.sourceGaps.length ?? 0};
}

export function readOriginal(folder) {
  const manifest = jsonFile(path.join(folder,'model.json'));
  const approved = catalog.find(m=>m.id===manifest.model?.id);
  assert(manifest.version===2 && approved, 'Not an approved merged original package');
  assert(JSON.stringify(manifest.model)===JSON.stringify(approved), 'Original source identity changed');
  assert(JSON.stringify(manifest.sources)===JSON.stringify(approved.sources.map(id=>approvedSources.find(s=>s.id===id))), 'Original source list changed');
  const glb = fs.readFileSync(path.join(folder,'model.glb'));
  assert(hash(glb)===manifest.originalGlbSha256, 'Original GLB changed. Use an untouched export as --original');
  const sourceFiles = {};
  for(const id of approved.sources) {
    const source = approvedSources.find(s=>s.id===id);
    for(const kind of ['model','animation']) {
      const name = id+'.'+kind+'.bin', bytes = fs.readFileSync(path.join(folder,name));
      assert(hash(bytes)===source[kind].sha256, 'Original source bytes changed: '+name);
      sourceFiles[name] = bytes;
    }
  }
  const referenceFiles = {};
  if(manifest.reference) {
    const reference = fs.readFileSync(path.join(folder,'reference.glb'));
    assert(hash(reference)===manifest.reference.sha256,'Original reference animation file changed');
    referenceFiles['reference.glb'] = reference;
    referenceFiles['animation-reference.json'] = fs.readFileSync(path.join(folder,'animation-reference.json'));
  }
  return {manifest,glb,sourceFiles,referenceFiles};
}
