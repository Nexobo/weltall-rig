import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function checkBlender(executable) {
  const resolved = path.resolve(executable);
  if (!fs.statSync(resolved).isFile()) throw Error('Blender executable is not a file');
  const result = spawnSync(resolved, ['--version'], {encoding:'utf8', windowsHide:true});
  if (result.error) throw result.error;
  const version = /^Blender (5\.0\.\d+)\b/m.exec(result.stdout ?? '')?.[1];
  if (result.status !== 0 || !version) throw Error('This release requires Blender 5.0');
  return {executable:resolved, version};
}

function run(executable, script, args) {
  const python = fileURLToPath(new URL(`../blender/${script}`, import.meta.url));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weltall-blender-'));
  try {
    const result = spawnSync(executable,
      ['--background', '--factory-startup', '--python-exit-code', '1', '--python', python, '--', ...args],
      {encoding:'utf8', windowsHide:true, maxBuffer:16*1024*1024,
        env:{...process.env, TEMP:temporary, TMP:temporary}});
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Blender failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(temporary, {recursive:true, force:true});
  }
}

export function createWeltallRig(family, out, executable) {
  if (fs.existsSync(out)) throw Error(`Output already exists: ${out}`);
  run(executable, 'create_id_rig.py', [path.resolve(family), path.resolve(out), 'weltall']);
}

export function readEdited(file, executable) {
  if (path.extname(file).toLowerCase() !== '.blend') return fs.readFileSync(file);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weltall-edit-'));
  try {
    const output = path.join(folder, 'edited.glb');
    run(executable, 'export_edits.py', [path.resolve(file), output]);
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(folder, {recursive:true, force:true});
  }
}
