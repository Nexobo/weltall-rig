import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareDisc} from './disc.mjs';
import {exportModel, hash} from './export.mjs';
import {catalog} from './catalog.mjs';
import {checkBlender, createWeltallRig} from './blender.mjs';

export async function buildRig(image, executable, destination) {
  const out = path.resolve(destination);
  if (fs.existsSync(out)) throw Error(`Output already exists: ${out}`);
  const blender = checkBlender(executable);
  fs.mkdirSync(path.dirname(out), {recursive:true});
  const temporary = fs.mkdtempSync(path.join(path.dirname(out), '.weltall-build-'));
  try {
    console.log('Reading and verifying Disc 1 resources...');
    const prepared = prepareDisc(path.resolve(image), path.join(temporary, 'source'));
    const original = path.join(temporary, 'original');
    console.log('Decoding model, textures, and all Weltall reference animations...');
    const exported = await exportModel(catalog[0], path.join(temporary, 'source'), path.join(original, 'weltall'), prepared);
    const rigFolder = path.join(temporary, 'rig');
    console.log('Building the Blender rig...');
    createWeltallRig(original, rigFolder, blender.executable);
    const rigReport = JSON.parse(fs.readFileSync(path.join(rigFolder, 'rig-report.json')));
    if (rigReport.clips !== 91 || rigReport.widgets.controls !== 67) throw Error('Unexpected rig/action coverage');
    fs.renameSync(original, path.join(rigFolder, 'original'));
    fs.copyFileSync(fileURLToPath(new URL('../docs/guide.html', import.meta.url)), path.join(rigFolder, 'guide.html'));
    const version = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)))).version;
    const report = {tool:'weltall-rig', version, source:prepared.source, blender:blender.version,
      model:exported.model, controls:67, uniqueActions:91,
      sourceAliases:rigReport.timeline.reduce((count, clip)=>count+clip.sourceAliases.length, 0),
      packedTextures:14, demonstrations:rigReport.demonstrations.length,
      blendSha256:hash(fs.readFileSync(path.join(rigFolder, 'weltall-rigged.blend'))),
      guide:'guide.html', original:'original/weltall', sourceGaps:rigReport.sourceGaps ?? [],
      reimportTarget:'Local GLB model package; original game format is not rewritten.'};
    fs.writeFileSync(path.join(rigFolder, 'build-report.json'), JSON.stringify(report, null, 2)+'\n');
    fs.renameSync(rigFolder, out);
    return report;
  } finally {
    fs.rmSync(temporary, {recursive:true, force:true});
  }
}
