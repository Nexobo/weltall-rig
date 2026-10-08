import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { XenoFormatError } from './binary-reader.js';
import { buildDiscCatalog, DISC_CATALOG_SCHEMA_VERSION } from './disc-catalog.js';
import { buildCrossDiscEquivalence } from './disc-equivalence.js';
import { findDiscImage, SECTOR_SIZE } from './disc-index.js';

export const SOURCE_WORKSPACE_SCHEMA_VERSION = 1;

const SOURCE_INDEX_FILE = 'source-index.json';
const READ_BATCH_SECTORS = 256;
const HASH_BUFFER_BYTES = 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function assertDiscNumber(discNumber) {
  if (discNumber !== 1 && discNumber !== 2) {
    throw new TypeError('Source workspace disc number must be 1 or 2.');
  }
}

function assertCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== DISC_CATALOG_SCHEMA_VERSION) {
    throw new TypeError('A current raw disc catalog is required.');
  }
  assertDiscNumber(catalog.source?.discNumber);
  if (!Array.isArray(catalog.files) || !Array.isArray(catalog.directories)) {
    throw new TypeError('Raw disc catalog records are missing.');
  }
  if (typeof catalog.catalogSha256 !== 'string' || catalog.catalogSha256.length !== 64) {
    throw new TypeError('Raw disc catalog hash is invalid.');
  }
}

function workspacePathForRecord(record) {
  if (record.recordType !== 'file') return null;
  const directory = record.storageLayout === 'mode2-stream' ? 'streams' : 'files';
  return `${directory}/file-${pad(record.flatIndex, 6)}.bin`;
}

function workspaceEncodingForRecord(record) {
  if (record.recordType !== 'file') return null;
  if (record.storageLayout === 'mode2-stream') {
    return 'concatenated-2336-byte-mode2-sector-bodies';
  }
  if (record.storageLayout === 'ordinary') return 'logical-2048-byte-sector-payloads';
  if (record.storageLayout === 'empty') return 'empty-file';
  throw new TypeError(`Source file ${record.id} has an invalid workspace encoding.`);
}

export function createSourceWorkspaceIndex(catalog) {
  assertCatalog(catalog);
  const records = catalog.files.map((record) => ({
    ...record,
    workspacePath: workspacePathForRecord(record),
    workspaceEncoding: workspaceEncodingForRecord(record),
  }));
  const readable = records.filter(({ recordType }) => recordType === 'file');
  const body = {
    schema: {
      name: 'xenogears-source-workspace',
      version: SOURCE_WORKSPACE_SCHEMA_VERSION,
    },
    sourceCatalog: {
      schemaVersion: catalog.schemaVersion,
      catalogSha256: catalog.catalogSha256,
    },
    source: { ...catalog.source },
    filesystemTable: { ...catalog.filesystemTable },
    summary: {
      ...catalog.summary,
      workspaceFileCount: readable.length,
      workspaceLogicalBytes: readable.reduce((total, record) => total + record.logicalBytes, 0),
    },
    accounting: catalog.accounting,
    directories: catalog.directories,
    files: records,
    duplicateGroups: catalog.duplicateGroups,
  };
  return {
    ...body,
    sourceIndexSha256: sha256(JSON.stringify(body)),
  };
}

function assertOwnedPath(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('Source workspace path escapes its configured root.');
  }
  return target;
}

function removeOwnedDirectory(rootDir, targetPath) {
  const target = assertOwnedPath(rootDir, targetPath);
  fs.rmSync(target, { recursive: true, force: true });
}

function readExact(fileDescriptor, buffer, length, position, label) {
  const bytesRead = fs.readSync(fileDescriptor, buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new XenoFormatError(`${label} is truncated`, 'TRUNCATED_DISC_IMAGE', {
      position,
      expectedBytes: length,
      bytesRead,
    });
  }
}

function validateSector(rawSector, sector) {
  if (rawSector[15] !== 2) {
    throw new XenoFormatError('Source workspace encountered a non-Mode-2 sector', 'INVALID_SECTOR_LAYOUT', {
      sector,
      mode: rawSector[15],
    });
  }
  if (!rawSector.subarray(16, 20).equals(rawSector.subarray(20, 24))) {
    throw new XenoFormatError('Mode-2 sector subheaders do not match', 'INVALID_SECTOR_LAYOUT', {
      sector,
    });
  }
}

function assertFileRecord(record, sectorCount) {
  if (!Number.isInteger(record.flatIndex) || record.flatIndex < 0) {
    throw new TypeError('Source file flat index is invalid.');
  }
  if (!Number.isInteger(record.logicalBytes) || record.logicalBytes < 0) {
    throw new TypeError(`Source file ${record.id} has an invalid byte count.`);
  }
  if (record.storageLayout === 'empty') {
    if (record.logicalBytes !== 0 || record.allocatedSectors !== 0) {
      throw new TypeError(`Empty source file ${record.id} has an invalid allocation.`);
    }
    return;
  }
  const expectedLayout = record.storageLayout === 'mode2-stream'
    ? { offset: 16, bytes: 2336 }
    : record.storageLayout === 'ordinary'
      ? { offset: 24, bytes: 2048 }
      : null;
  if (
    !expectedLayout
    || record.sectorPayloadOffset !== expectedLayout.offset
    || record.sectorPayloadBytes !== expectedLayout.bytes
  ) {
    throw new TypeError(`Source file ${record.id} has an invalid storage layout.`);
  }
  if (record.storageLayout === 'mode2-stream' && record.logicalBytes % 2336 !== 0) {
    throw new TypeError(`Source stream ${record.id} is not aligned to complete sector bodies.`);
  }
  const expectedSectors = Math.ceil(record.logicalBytes / record.sectorPayloadBytes);
  if (
    !Number.isInteger(record.sector)
    || record.sector < 0
    || record.allocatedSectors !== expectedSectors
    || record.sector + expectedSectors > sectorCount
  ) {
    throw new TypeError(`Source file ${record.id} has an invalid sector allocation.`);
  }
}

function extractFileRecord({ imageFile, imageSectorCount, outputPath, record }) {
  assertFileRecord(record, imageSectorCount);
  const payloadHash = crypto.createHash('sha256');
  const rawSectorHash = crypto.createHash('sha256');
  const outputFile = fs.openSync(outputPath, 'wx');
  try {
    if (record.logicalBytes > 0) {
      const batch = Buffer.allocUnsafe(READ_BATCH_SECTORS * SECTOR_SIZE);
      let remainingBytes = record.logicalBytes;
      let completedSectors = 0;
      while (completedSectors < record.allocatedSectors) {
        const batchSectors = Math.min(
          READ_BATCH_SECTORS,
          record.allocatedSectors - completedSectors,
        );
        const batchBytes = batchSectors * SECTOR_SIZE;
        readExact(
          imageFile,
          batch,
          batchBytes,
          (record.sector + completedSectors) * SECTOR_SIZE,
          `source file ${record.id}`,
        );
        for (let index = 0; index < batchSectors; index += 1) {
          const sector = record.sector + completedSectors + index;
          const rawOffset = index * SECTOR_SIZE;
          const rawSector = batch.subarray(rawOffset, rawOffset + SECTOR_SIZE);
          validateSector(rawSector, sector);
          rawSectorHash.update(rawSector);
          const payloadBytes = Math.min(record.sectorPayloadBytes, remainingBytes);
          const payload = rawSector.subarray(
            record.sectorPayloadOffset,
            record.sectorPayloadOffset + payloadBytes,
          );
          const written = fs.writeSync(outputFile, payload);
          if (written !== payload.length) {
            throw new Error(`Source file ${record.id} could not be written completely.`);
          }
          payloadHash.update(payload);
          remainingBytes -= payloadBytes;
        }
        completedSectors += batchSectors;
      }
      if (remainingBytes !== 0) {
        throw new Error(`Source file ${record.id} extraction did not consume its logical size.`);
      }
    }
  } finally {
    fs.closeSync(outputFile);
  }

  const payloadSha256 = payloadHash.digest('hex');
  const rawSectorSha256 = rawSectorHash.digest('hex');
  if (payloadSha256 !== record.payloadSha256 || rawSectorSha256 !== record.rawSectorSha256) {
    throw new XenoFormatError('Extracted source file does not match its catalog hashes', 'SOURCE_HASH_MISMATCH', {
      id: record.id,
      payloadSha256,
      expectedPayloadSha256: record.payloadSha256,
      rawSectorSha256,
      expectedRawSectorSha256: record.rawSectorSha256,
    });
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    while (true) {
      const bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }
  return hash.digest('hex');
}

export function readSourceWorkspaceIndex(workspaceDir) {
  const indexPath = path.join(workspaceDir, SOURCE_INDEX_FILE);
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (error) {
    throw new Error(`Source workspace index is invalid: ${error.message}`);
  }
  if (
    index?.schema?.name !== 'xenogears-source-workspace'
    || index.schema.version !== SOURCE_WORKSPACE_SCHEMA_VERSION
    || !Array.isArray(index.files)
    || typeof index.sourceIndexSha256 !== 'string'
  ) {
    throw new TypeError('Source workspace index schema is invalid.');
  }
  const { sourceIndexSha256, ...body } = index;
  if (sha256(JSON.stringify(body)) !== sourceIndexSha256) {
    throw new Error('Source workspace index hash does not match its contents.');
  }
  return index;
}

function listedWorkspaceFiles(workspaceDir, directory) {
  const directoryPath = path.join(workspaceDir, directory);
  if (!fs.existsSync(directoryPath)) return [];
  return fs.readdirSync(directoryPath, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile()) {
      throw new Error(`Source workspace contains a non-file entry: ${directory}/${entry.name}`);
    }
    return `${directory}/${entry.name}`;
  }).sort();
}

function sumValues(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is missing from the source workspace index.`);
  }
  const values = Object.values(value);
  if (values.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new TypeError(`${label} contains an invalid byte count.`);
  }
  return values.reduce((total, item) => total + item, 0);
}

function verifySourceAccounting(index) {
  const physicalBytes = index.accounting?.physicalBytes;
  const sectorLayout = index.accounting?.sectorLayout;
  const references = index.accounting?.references;
  const layoutBytes = [
    'headerBytes',
    'subheaderBytes',
    'form1UserBytes',
    'form1IntegrityBytes',
    'form2UserBytes',
    'form2IntegrityBytes',
  ].reduce((total, field) => {
    const value = sectorLayout?.[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Source sector-layout accounting contains an invalid byte count.');
    }
    return total + value;
  }, 0);
  if (
    sumValues(physicalBytes, 'Source physical-byte accounting') !== index.source.bytes
    || layoutBytes !== index.source.bytes
  ) {
    throw new Error('Source workspace byte accounting does not close the disc image.');
  }
  if (
    references?.logicalOccurrenceBytes !== index.summary.workspaceLogicalBytes
    || references?.overlappingReferenceBytes !== 0
    || references?.multiplyReferencedPhysicalBytes !== 0
  ) {
    throw new Error('Source workspace reference accounting is invalid.');
  }
  for (const field of [
    'fileTailUnresolvedBytes',
    'unreferencedUnresolvedBytes',
    'form2ExtendedUnresolvedBytes',
  ]) {
    if (physicalBytes[field] !== 0) {
      throw new Error(`Source workspace contains unresolved physical bytes: ${field}.`);
    }
  }
}

function catalogBodyFromSourceIndex(index) {
  const {
    workspaceFileCount: _workspaceFileCount,
    workspaceLogicalBytes: _workspaceLogicalBytes,
    ...summary
  } = index.summary;
  const files = index.files.map((record) => {
    const {
      workspacePath: _workspacePath,
      workspaceEncoding: _workspaceEncoding,
      ...sourceRecord
    } = record;
    return sourceRecord;
  });
  return {
    schemaVersion: index.sourceCatalog.schemaVersion,
    source: index.source,
    filesystemTable: index.filesystemTable,
    summary,
    accounting: index.accounting,
    directories: index.directories,
    files,
    duplicateGroups: index.duplicateGroups,
  };
}

function verifySourceCatalogDigest(index) {
  if (sha256(JSON.stringify(catalogBodyFromSourceIndex(index))) !== index.sourceCatalog.catalogSha256) {
    throw new Error('Source workspace does not reproduce its raw catalog hash.');
  }
}

export function verifySourceWorkspace(workspaceDir) {
  const root = path.resolve(workspaceDir);
  const index = readSourceWorkspaceIndex(root);
  assertDiscNumber(index.source?.discNumber);
  verifySourceCatalogDigest(index);
  verifySourceAccounting(index);
  const records = index.files.filter(({ recordType }) => recordType === 'file');
  const expectedPaths = new Set();
  let verifiedBytes = 0;

  for (const record of records) {
    const expectedPath = workspacePathForRecord(record);
    if (
      record.workspacePath !== expectedPath
      || record.workspaceEncoding !== workspaceEncodingForRecord(record)
      || expectedPaths.has(expectedPath)
    ) {
      throw new Error(`Source workspace path is invalid or duplicated for ${record.id}.`);
    }
    expectedPaths.add(expectedPath);
    const filePath = assertOwnedPath(root, path.join(root, ...expectedPath.split('/')));
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size !== record.logicalBytes) {
      throw new Error(`Source workspace file size is invalid for ${record.id}.`);
    }
    const actualHash = hashFile(filePath);
    if (actualHash !== record.payloadSha256) {
      throw new Error(`Source workspace file hash is invalid for ${record.id}.`);
    }
    verifiedBytes += stats.size;
  }

  const actualPaths = [
    ...listedWorkspaceFiles(root, 'files'),
    ...listedWorkspaceFiles(root, 'streams'),
  ];
  if (
    actualPaths.length !== expectedPaths.size
    || actualPaths.some((filePath) => !expectedPaths.has(filePath))
  ) {
    throw new Error('Source workspace contains missing or unexpected payload files.');
  }
  if (
    index.summary?.workspaceFileCount !== records.length
    || index.summary?.workspaceLogicalBytes !== verifiedBytes
  ) {
    throw new Error('Source workspace summary does not match its payload files.');
  }

  return {
    discNumber: index.source.discNumber,
    sourceIndexSha256: index.sourceIndexSha256,
    catalogSha256: index.sourceCatalog.catalogSha256,
    fileCount: records.length,
    ordinaryFileCount: records.filter(({ storageLayout }) => storageLayout === 'ordinary').length,
    streamFileCount: records.filter(({ storageLayout }) => storageLayout === 'mode2-stream').length,
    logicalBytes: verifiedBytes,
  };
}

function publishWorkspace(sourceRootDir, stagingDir, finalDir, discNumber) {
  const token = `${process.pid}-${Date.now()}`;
  const backupDir = path.join(sourceRootDir, `.disc-${discNumber}-previous-${token}`);
  let backedUp = false;
  if (fs.existsSync(finalDir)) {
    fs.renameSync(finalDir, backupDir);
    backedUp = true;
  }
  try {
    fs.renameSync(stagingDir, finalDir);
  } catch (error) {
    if (backedUp && !fs.existsSync(finalDir)) fs.renameSync(backupDir, finalDir);
    throw error;
  }
  if (backedUp) removeOwnedDirectory(sourceRootDir, backupDir);
}

export function writeDiscSourceWorkspace({
  imagePath,
  sourceRootDir,
  catalog,
  onProgress = () => {},
}) {
  assertCatalog(catalog);
  if (typeof imagePath !== 'string' || typeof sourceRootDir !== 'string') {
    throw new TypeError('Source image and workspace root paths are required.');
  }
  const imageStats = fs.statSync(imagePath);
  if (!imageStats.isFile() || imageStats.size !== catalog.source.bytes) {
    throw new XenoFormatError('Source image size does not match its catalog', 'SOURCE_IMAGE_MISMATCH', {
      expectedBytes: catalog.source.bytes,
      actualBytes: imageStats.size,
    });
  }

  const discNumber = catalog.source.discNumber;
  const sourceRoot = path.resolve(sourceRootDir);
  const token = `${process.pid}-${Date.now()}`;
  const stagingDir = assertOwnedPath(
    sourceRoot,
    path.join(sourceRoot, `.disc-${discNumber}-stage-${token}`),
  );
  const finalDir = assertOwnedPath(sourceRoot, path.join(sourceRoot, `disc-${discNumber}`));
  fs.mkdirSync(path.join(stagingDir, 'files'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'streams'), { recursive: true });

  const index = createSourceWorkspaceIndex(catalog);
  const records = index.files.filter(({ recordType }) => recordType === 'file');
  const imageFile = fs.openSync(imagePath, 'r');
  let completedBytes = 0;
  try {
    records.forEach((record, recordIndex) => {
      const outputPath = path.join(stagingDir, ...record.workspacePath.split('/'));
      extractFileRecord({
        imageFile,
        imageSectorCount: catalog.source.sectorCount,
        outputPath,
        record,
      });
      completedBytes += record.logicalBytes;
      if (recordIndex % 25 === 0 || recordIndex + 1 === records.length) {
        onProgress({
          phase: 'extract-source',
          discNumber,
          completed: recordIndex + 1,
          total: records.length,
          completedBytes,
          totalBytes: index.summary.workspaceLogicalBytes,
          message: `Extracted ${recordIndex + 1} of ${records.length} Disc ${discNumber} source files`,
        });
      }
    });
  } catch (error) {
    removeOwnedDirectory(sourceRoot, stagingDir);
    throw error;
  } finally {
    fs.closeSync(imageFile);
  }

  try {
    fs.writeFileSync(
      path.join(stagingDir, SOURCE_INDEX_FILE),
      `${JSON.stringify(index, null, 2)}\n`,
      { flag: 'wx' },
    );
    onProgress({
      phase: 'verify-source',
      discNumber,
      completed: 0,
      total: records.length,
      message: `Verifying Disc ${discNumber} source workspace`,
    });
    const verification = verifySourceWorkspace(stagingDir);
    publishWorkspace(sourceRoot, stagingDir, finalDir, discNumber);
    onProgress({
      phase: 'verify-source',
      discNumber,
      completed: records.length,
      total: records.length,
      message: `Disc ${discNumber} source workspace verified`,
    });
    return {
      ...verification,
      workspaceDir: finalDir,
      sourceIndexPath: path.join(finalDir, SOURCE_INDEX_FILE),
    };
  } catch (error) {
    if (fs.existsSync(stagingDir)) removeOwnedDirectory(sourceRoot, stagingDir);
    throw error;
  }
}

export function buildDiscSourceWorkspace({ imagePath, sourceRootDir, onProgress = () => {} }) {
  onProgress({
    phase: 'catalog-source',
    completed: 0,
    total: 1,
    message: 'Building complete disc catalog',
  });
  const catalog = buildDiscCatalog(imagePath);
  onProgress({
    phase: 'catalog-source',
    discNumber: catalog.source.discNumber,
    completed: 1,
    total: 1,
    message: `Disc ${catalog.source.discNumber} catalog verified`,
  });
  return writeDiscSourceWorkspace({ imagePath, sourceRootDir, catalog, onProgress });
}

function catalogFromSourceIndex(index) {
  return {
    ...catalogBodyFromSourceIndex(index),
    catalogSha256: index.sourceCatalog.catalogSha256,
  };
}

function publishSourceReport(sourceRootDir, fileName, report) {
  const root = path.resolve(sourceRootDir);
  const token = `${process.pid}-${Date.now()}`;
  const finalPath = assertOwnedPath(root, path.join(root, fileName));
  const stagingPath = assertOwnedPath(root, path.join(root, `.${fileName}.${token}.staging`));
  const backupPath = assertOwnedPath(root, path.join(root, `.${fileName}.${token}.previous`));
  fs.writeFileSync(stagingPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  let backedUp = false;
  if (fs.existsSync(finalPath)) {
    fs.renameSync(finalPath, backupPath);
    backedUp = true;
  }
  try {
    fs.renameSync(stagingPath, finalPath);
  } catch (error) {
    if (backedUp && !fs.existsSync(finalPath)) fs.renameSync(backupPath, finalPath);
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath);
    throw error;
  }
  if (backedUp) fs.rmSync(backupPath);
  return finalPath;
}

export function writeSourceEquivalence(sourceRootDir) {
  const first = readSourceWorkspaceIndex(path.join(sourceRootDir, 'disc-1'));
  const second = readSourceWorkspaceIndex(path.join(sourceRootDir, 'disc-2'));
  const report = buildCrossDiscEquivalence(
    catalogFromSourceIndex(first),
    catalogFromSourceIndex(second),
  );
  const outputPath = publishSourceReport(
    sourceRootDir,
    'cross-disc-equivalence.json',
    report,
  );
  return { report, outputPath };
}

export function verifyCompleteSourceWorkspaces(sourceRootDir) {
  const discs = [1, 2].map((discNumber) => verifySourceWorkspace(
    path.join(sourceRootDir, `disc-${discNumber}`),
  ));
  const first = readSourceWorkspaceIndex(path.join(sourceRootDir, 'disc-1'));
  const second = readSourceWorkspaceIndex(path.join(sourceRootDir, 'disc-2'));
  const expected = buildCrossDiscEquivalence(
    catalogFromSourceIndex(first),
    catalogFromSourceIndex(second),
  );
  const reportPath = path.join(sourceRootDir, 'cross-disc-equivalence.json');
  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(`Source equivalence report is invalid: ${error.message}`);
  }
  if (sha256(JSON.stringify(actual)) !== sha256(JSON.stringify(expected))) {
    throw new Error('Source equivalence report does not match the two source workspaces.');
  }
  return {
    discs,
    equivalenceSha256: actual.equivalenceSha256,
    payloadGroupCount: actual.summary.payloadGroupCount,
  };
}

export function buildCompleteSourceWorkspaces({
  discImagesDir,
  sourceRootDir,
  onProgress = () => {},
}) {
  if (typeof discImagesDir !== 'string' || typeof sourceRootDir !== 'string') {
    throw new TypeError('Disc-image and source-workspace roots are required.');
  }
  const results = [];
  for (const discNumber of [1, 2]) {
    const disc = findDiscImage(discImagesDir, discNumber);
    results.push(buildDiscSourceWorkspace({
      imagePath: disc.path,
      sourceRootDir,
      onProgress,
    }));
  }
  const equivalence = writeSourceEquivalence(sourceRootDir);
  return {
    discs: results,
    equivalenceSha256: equivalence.report.equivalenceSha256,
    payloadGroupCount: equivalence.report.summary.payloadGroupCount,
    equivalencePath: equivalence.outputPath,
  };
}
