import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args], {encoding:'utf8', windowsHide:true});

test('CLI help works without installed Blender or game files', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /build <disc-1\.bin>/);
  assert.match(result.stdout, /import <edited\.blend/);
});

test('missing required paths fails before producing an output', () => {
  const result = run(['build', 'disc.bin', '--out', 'unused']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--blender/);
});

test('build refuses an existing output before opening any input or Blender', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weltall-existing-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'keep.txt'), 'existing user work');
    const result = run(['build', 'missing.bin', '--blender', 'missing.exe', '--out', directory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Output already exists/);
    assert.equal(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8'), 'existing user work');
    assert.deepEqual(fs.readdirSync(directory), ['keep.txt']);
  } finally { fs.rmSync(directory, {recursive:true, force:true}); }
});

test('import refuses an existing output before reading the edited file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weltall-import-test-'));
  try {
    const result = run(['import', 'missing.blend', '--blender', 'missing.exe', '--original', 'missing', '--out', directory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Output already exists/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, {recursive:true, force:true}); }
});
