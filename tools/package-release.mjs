import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `weltall-rig-${metadata.version}-windows-x64`;
const stage = path.join(root, '.release', name);
const artifacts = path.join(root, 'artifacts');
const zip = path.join(artifacts, `${name}.zip`);
const projectFiles = ['cli.mjs', 'package.json', 'package-lock.json', 'README.md',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'weltall-rig.cmd'];
const sourceTrees = { lib: ['.mjs'], blender: ['.py'], docs: ['.md', '.html'],
  vendor: ['.js', '.json'], 'vendor-battle': ['.js', '.json'],
  'vendor-disc': ['.js', '.json'] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function filesAt(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${filename}`);
    return entry.isDirectory() ? filesAt(filename) : [filename];
  });
}

function copyProject(relative) {
  const source = path.join(root, relative);
  const bytes = fs.readFileSync(source);
  const text = bytes.toString('utf8');
  if (/C:[/\\]+Users[/\\]|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/i.test(text)) {
    throw new Error(`Private path or credential marker in ${relative}`);
  }
  const target = path.join(stage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function packageRelease() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Build the Windows x64 release with Windows x64 Node.js.');
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required.');
  if (fs.existsSync(stage) || fs.existsSync(zip)) throw new Error('Release staging/output already exists; choose a new package version.');
  const runtimeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
  if (!fs.existsSync(runtimeLicense)) throw new Error('Node.js distribution LICENSE is missing next to node.exe.');
  const nodeLicense = fs.readFileSync(runtimeLicense, 'utf8');
  if (!nodeLicense.includes('Node.js') || nodeLicense.length < 50000) {
    throw new Error('Expected the complete Node.js distribution license and third-party notices.');
  }
  fs.mkdirSync(stage, { recursive: true });
  for (const relative of projectFiles) copyProject(relative);
  for (const [tree, extensions] of Object.entries(sourceTrees)) {
    for (const filename of filesAt(path.join(root, tree))) {
      const relative = path.relative(root, filename);
      if (relative.split(path.sep).includes('__pycache__')) continue;
      const extension = path.extname(filename);
      if (!extensions.includes(extension) || (extension === '.json' && path.basename(filename) !== 'SNAPSHOT.json')) {
        throw new Error(`Non-source file in release source tree: ${relative}`);
      }
      copyProject(relative);
    }
  }
  const lock = JSON.parse(fs.readFileSync(path.join(stage, 'package-lock.json'), 'utf8'));
  for (const [relative, dependency] of Object.entries(lock.packages)) {
    if (!relative) continue;
    if (dependency.dev || dependency.link || !relative.startsWith('node_modules/')) {
      throw new Error(`Unexpected release dependency: ${relative}`);
    }
    const folder = path.join(root, relative);
    const license = fs.readdirSync(folder).find(file => /^licen[cs]e(?:\.|$)/i.test(file));
    if (!license) throw new Error(`Missing dependency license: ${relative}`);
    const installed = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    if (installed.version !== dependency.version) throw new Error(`Dependency version mismatch: ${relative}`);
    const destination = path.join(stage, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(folder, destination, { recursive: true, errorOnExist: true, force: false });
  }
  fs.mkdirSync(path.join(stage, 'runtime'));
  fs.copyFileSync(process.execPath, path.join(stage, 'runtime', 'node.exe'));
  fs.copyFileSync(runtimeLicense, path.join(stage, 'runtime', 'LICENSE'));
  const help = run(path.join(stage, 'runtime', 'node.exe'), ['cli.mjs', '--help'], stage);
  if (!help.includes('--blender') || !help.includes('build')) throw new Error('Packaged CLI help failed.');

  const entries = filesAt(stage).map(filename => ({
    path: path.relative(stage, filename).replaceAll('\\', '/'),
    bytes: fs.statSync(filename).size,
    sha256: hash(fs.readFileSync(filename)),
  }));
  for (const entry of entries) {
    const source = projectFiles.includes(entry.path)
      || Object.keys(sourceTrees).some(tree => entry.path.startsWith(`${tree}/`));
    const runtime = ['runtime/node.exe', 'runtime/LICENSE'].includes(entry.path);
    const dependency = entry.path.startsWith('node_modules/');
    if (!source && !runtime && !dependency) throw new Error(`Unexpected packaged file: ${entry.path}`);
    if (/\.(?:blend\d*|glb|gltf|iso|cue|bin|png|jpg|jpeg|webp|wav|ogg)$/i.test(entry.path)) {
      throw new Error(`Asset file forbidden in release: ${entry.path}`);
    }
  }
  const manifest = { name, version: metadata.version, node: process.versions.node,
    license: metadata.license, noGameAssets: true, entries };
  fs.writeFileSync(path.join(stage, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(artifacts, { recursive: true });
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; `
    + `[System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(stage)}, ${psQuote(zip)}, [System.IO.Compression.CompressionLevel]::Optimal, $true)`]);
  const archived = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; `
    + `$archive = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(zip)}); try { `
    + `$sha = [System.Security.Cryptography.SHA256]::Create(); @($archive.Entries | Where-Object { $_.Name } | ForEach-Object { `
    + `$stream = $_.Open(); try { @{ path = $_.FullName.Replace('\\', '/'); bytes = $_.Length; `
    + `sha256 = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } } finally { $stream.Dispose() } `
    + `}) | ConvertTo-Json -Compress } finally { $archive.Dispose() }`]));
  const expected = new Map([...entries, { path: 'release-manifest.json',
    bytes: fs.statSync(path.join(stage, 'release-manifest.json')).size,
    sha256: hash(fs.readFileSync(path.join(stage, 'release-manifest.json'))) }].map(entry => [entry.path, entry]));
  if (archived.length !== expected.size) throw new Error('Archive file count mismatch.');
  for (const entry of archived) {
    const relative = entry.path.startsWith(`${name}/`) ? entry.path.slice(name.length + 1) : '';
    const original = expected.get(relative);
    if (!original || original.bytes !== entry.bytes || original.sha256 !== entry.sha256) {
      throw new Error(`Archive content mismatch: ${entry.path}`);
    }
    expected.delete(relative);
  }
  if (expected.size) throw new Error('Archive is missing expected files.');
  const checksum = hash(fs.readFileSync(zip));
  fs.writeFileSync(path.join(artifacts, 'SHA256SUMS.txt'), `${checksum}  ${path.basename(zip)}\n`);
  fs.writeFileSync(path.join(artifacts, 'package-audit.json'), `${JSON.stringify({
    ...manifest, archive: path.basename(zip), sha256: checksum,
    archiveFilesVerified: archived.length, status: 'passed',
  }, null, 2)}\n`);
  console.log(`Created and audited ${zip}\nSHA256 ${checksum}`);
}

try { packageRelease(); } catch (error) { console.error(error.message); process.exitCode = 1; }
