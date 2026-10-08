#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {buildRig} from './lib/build.mjs';
import {checkBlender, readEdited} from './lib/blender.mjs';
import {hash, readOriginal, writePackage} from './lib/export.mjs';
import {importEdited, readGlb, validateEdited} from './lib/glb.mjs';

const help = `Weltall Rig
  weltall-rig build <disc-1.bin> --blender <blender.exe> --out <new-folder>
  weltall-rig import <edited.blend|edited.glb> --blender <blender.exe> --original <build-folder/original/weltall> --out <new-folder>
  weltall-rig validate <edited.blend|edited.glb> --blender <blender.exe> --original <build-folder/original/weltall>

Requires Blender 5.0 and the supported raw Disc 1 BIN image.
Outputs are local files. Existing output folders are never overwritten.`;

try {
  const {values, positionals} = parseArgs({allowPositionals:true, options:{
    blender:{type:'string'}, out:{type:'string'}, original:{type:'string'}, help:{type:'boolean'}}});
  const [command, target] = positionals;
  if (values.help || !command) console.log(help);
  else {
    if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or newer is required');
    if (positionals.length !== 2 || !values.blender) throw Error(help);
    if (command === 'build') {
      if (!values.out || values.original) throw Error(help);
      const report = await buildRig(target, values.blender, values.out);
      console.log(`Created ${path.resolve(values.out, 'weltall-rigged.blend')}\nGuide: ${path.resolve(values.out, 'guide.html')}\n${report.uniqueActions} unique reference actions; ${report.controls} controls.`);
    } else if (command === 'import' || command === 'validate') {
      if (!values.original || (command === 'import' ? !values.out : values.out)) throw Error(help);
      if (command === 'import' && fs.existsSync(values.out)) throw Error(`Output already exists: ${values.out}`);
      const blender = checkBlender(values.blender);
      const original = readOriginal(values.original), edited = readEdited(target, blender.executable);
      if (command === 'validate') {
        await validateEdited(original.glb, edited);
        console.log('Valid: original hierarchy, rest transforms, textures, and part assignments retained.');
      } else {
        const result = await importEdited(original.glb, edited);
        const record = {...original.manifest, replacementGlbSha256:hash(result), editedGlbSha256:hash(edited),
          exportedClips:(readGlb(result).json.animations ?? []).map(animation=>animation.name),
          policy:'Original hierarchy retained; mesh, UV, texture edits and baked node animations accepted.',
          note:'Local replacement package. Original game BINs and disc image remain unchanged.'};
        const references = {...original.referenceFiles};
        if (record.reference) {
          references['reference.glb'] = await importEdited(original.referenceFiles['reference.glb'], edited);
          record.reference = {...record.reference, sha256:hash(references['reference.glb'])};
        }
        writePackage(values.out, {...references, 'model.glb':result, 'model.json':JSON.stringify(record,null,2)+'\n', ...original.sourceFiles});
        console.log(`Replacement written to ${path.resolve(values.out)}`);
      }
    } else throw Error(`Unknown command: ${command}\n${help}`);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
