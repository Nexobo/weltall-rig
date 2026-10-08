import crypto from 'node:crypto';
import fs from 'node:fs';

import { XenoFormatError } from './binary-reader.js';
import {
  SECTOR_DATA_OFFSET,
  SECTOR_DATA_SIZE,
  SECTOR_SIZE,
  WORLDMAP_CONFIG_BASES,
  getWorldmapFileIndexMap,
  readDiscFilesystem,
} from './disc-index.js';
import {
  SHARED_BATTLE_SPRITE_FLAT_INDEX,
  SHARED_BATTLE_SPRITE_TEXTURE_FLAT_INDEX,
  SPRITE_RESOURCE_DEFINITIONS,
} from './sprite-resources.js';

export const DISC_CATALOG_SCHEMA_VERSION = 1;

const FORM2_FLAG = 0x20;
const FORM2_DATA_SIZE = 2324;
const FORM2_EXTRA_DATA_SIZE = FORM2_DATA_SIZE - SECTOR_DATA_SIZE;
const HASH_PREFIX_BYTES = 16;
const READ_BATCH_SECTORS = 256;
const ZERO_SECTOR_PAYLOAD = Buffer.alloc(SECTOR_DATA_SIZE);
const DISC_TWO_FLAT_INDEX_OFFSET = -5;
const WORLDMAP_ROLES = Object.freeze([
  'configuration',
  'ground-textures',
  'shared-textures',
  'sound-1',
  'sound-2',
  'sound-3',
  'sound-4',
  'battle-music',
  'terrain-row-major',
  'terrain-transposed',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pad(value, width) {
  return value.toString().padStart(width, '0');
}

function assertDiscNumber(discNumber) {
  if (discNumber !== 1 && discNumber !== 2) {
    throw new TypeError('Disc number must be 1 or 2.');
  }
}

function assertDirectoryOrdinal(directoryOrdinal) {
  if (!Number.isInteger(directoryOrdinal) || directoryOrdinal < 0) {
    throw new TypeError('Directory ordinal must be a non-negative integer.');
  }
}

export function createRawDirectoryId(discNumber, directoryOrdinal) {
  assertDiscNumber(discNumber);
  assertDirectoryOrdinal(directoryOrdinal);
  return directoryOrdinal === 0
    ? `xg:d${discNumber}:root`
    : `xg:d${discNumber}:dir-${pad(directoryOrdinal, 4)}`;
}

export function createRawFileId(discNumber, flatIndex) {
  assertDiscNumber(discNumber);
  if (!Number.isInteger(flatIndex) || flatIndex < 0) {
    throw new TypeError('Flat file index must be a non-negative integer.');
  }
  return `xg:d${discNumber}:file-${pad(flatIndex, 6)}`;
}

function addUse(usesByFlatIndex, flatIndex, use) {
  if (!usesByFlatIndex.has(flatIndex)) usesByFlatIndex.set(flatIndex, []);
  usesByFlatIndex.get(flatIndex).push(use);
}

function sourceFlatIndex(discNumber, discOneFlatIndex) {
  return discOneFlatIndex + (discNumber === 2 ? DISC_TWO_FLAT_INDEX_OFFSET : 0);
}

function knownUsesByFlatIndex(imagePath, discNumber) {
  const uses = new Map();
  for (const definition of SPRITE_RESOURCE_DEFINITIONS) {
    addUse(uses, sourceFlatIndex(discNumber, definition.flatIndex), {
      family: 'sprite',
      role: definition.category,
      resourceId: definition.id,
      compression: definition.compression,
    });
  }
  addUse(uses, sourceFlatIndex(discNumber, SHARED_BATTLE_SPRITE_TEXTURE_FLAT_INDEX), {
    family: 'sprite',
    role: 'shared-battle-texture',
    resourceId: 'shared-battle-sprite-texture',
    compression: null,
  });
  addUse(uses, sourceFlatIndex(discNumber, SHARED_BATTLE_SPRITE_FLAT_INDEX), {
    family: 'sprite',
    role: 'shared-battle-control',
    resourceId: 'shared-battle-sprite',
    compression: null,
  });

  const worldmapIndexes = getWorldmapFileIndexMap(imagePath);
  WORLDMAP_CONFIG_BASES.forEach((baseFileId, worldMapIndex) => {
    WORLDMAP_ROLES.forEach((role, roleIndex) => {
      const localFileId = baseFileId + roleIndex + 1;
      addUse(uses, worldmapIndexes.get(localFileId), {
        family: 'world-map',
        role,
        resourceId: `world-map-${worldMapIndex + 1}-${role}`,
        compression: roleIndex < 3 ? 'lzs' : null,
      });
    });
  });
  return uses;
}

function structuralSectorKind(sector) {
  if (sector < 16) return 'system-area';
  if (sector < 24) return 'disc-metadata';
  if (sector < 40) return 'filesystem-table';
  if (sector === 40) return 'game-directory-table';
  return null;
}

function allZero(buffer) {
  return buffer.equals(ZERO_SECTOR_PAYLOAD.subarray(0, buffer.length));
}

function probePayload(prefix, knownUses) {
  const compression = [...new Set(knownUses.map((use) => use.compression).filter(Boolean))];
  let container = null;
  if (prefix.subarray(0, 8).toString('ascii') === 'PS-X EXE') {
    container = 'playstation-executable';
  } else if (prefix.length >= 4 && prefix.readUInt32LE(0) === 0x10) {
    container = 'playstation-tim-signature';
  } else if (prefix.subarray(0, 4).toString('ascii') === 'RIFF') {
    container = 'riff-signature';
  } else if (prefix.subarray(0, 4).toString('ascii') === "It's") {
    container = 'removed-field-placeholder';
  }
  return {
    compression: compression.length === 0 ? null : compression,
    container,
  };
}

function flattenFilesystem(root, discNumber, flatUses) {
  const directories = [];
  const files = [];

  function visit(directory, parent, directoryIndex) {
    const id = createRawDirectoryId(discNumber, directory.ordinal);
    const name = directory.ordinal === 0 ? 'DISC_ROOT' : `DIR_${pad(directory.ordinal, 4)}`;
    const logicalPath = parent === null ? name : `${parent.logicalPath}/${name}`;
    const record = {
      id,
      recordType: 'directory',
      ordinal: directory.ordinal,
      directoryIndex,
      parentId: parent?.id ?? null,
      logicalPath,
      flatIndex: directory.flatIndex ?? null,
      sector: directory.sector ?? null,
      entryCount: directory.entryCount ?? null,
    };
    directories.push(record);

    directory.files.forEach((file, fileIndex) => {
      const marker = file.sector === 0xffffff;
      const knownUses = [];
      if (!marker && directory.ordinal === 12) {
        knownUses.push({
          family: 'field',
          role: 'directory-resource',
          resourceId: `field-resource-${fileIndex}`,
          compression: null,
        });
      }
      if (!marker && directory.ordinal === 13) {
        knownUses.push({
          family: 'scene-model',
          role: 'directory-resource',
          resourceId: `scene-model-resource-${fileIndex}`,
          compression: null,
        });
      }
      knownUses.push(...(flatUses.get(file.flatIndex) ?? []));

      files.push({
        id: createRawFileId(discNumber, file.flatIndex),
        recordType: marker ? 'padding-marker' : 'file',
        directoryId: id,
        directoryOrdinal: directory.ordinal,
        directoryPath: logicalPath,
        fileIndex,
        fileNumber: fileIndex + 1,
        logicalName: `FILE_${pad(fileIndex + 1, 4)}.bin`,
        flatIndex: file.flatIndex,
        sector: marker ? null : file.sector,
        logicalBytes: file.size,
        storageLayout: marker ? 'none' : null,
        sectorPayloadOffset: marker ? null : 0,
        sectorPayloadBytes: marker ? 0 : 0,
        allocatedSectors: 0,
        allocatedRawBytes: 0,
        payloadSha256: null,
        rawSectorSha256: null,
        classification: marker ? 'padding' : knownUses.length > 0 ? 'known' : 'unresolved',
        knownUses,
        probe: null,
        duplicateOf: null,
      });
    });

    directory.directories.forEach((child, childIndex) => visit(child, record, childIndex));
  }

  visit(root, null, 0);
  directories.sort((left, right) => left.ordinal - right.ordinal);
  files.sort((left, right) => left.flatIndex - right.flatIndex);
  return { directories, files };
}

function makeAccounting() {
  return {
    sectorLayout: {
      mode2Form1Sectors: 0,
      mode2Form2Sectors: 0,
      headerBytes: 0,
      subheaderBytes: 0,
      form1UserBytes: 0,
      form1IntegrityBytes: 0,
      form2UserBytes: 0,
      form2IntegrityBytes: 0,
    },
    physicalBytes: {
      sectorHeaderBytes: 0,
      ordinarySubheaderBytes: 0,
      ordinaryIntegrityBytes: 0,
      knownFileContentBytes: 0,
      unresolvedFileContentBytes: 0,
      fileTailZeroPaddingBytes: 0,
      fileTailUnresolvedBytes: 0,
      structuralPayloadBytes: 0,
      unreferencedZeroPaddingBytes: 0,
      unreferencedUnresolvedBytes: 0,
      form2ExtendedStructuralBytes: 0,
      form2ExtendedZeroPaddingBytes: 0,
      form2ExtendedUnresolvedBytes: 0,
    },
    references: {
      logicalOccurrenceBytes: 0,
      uniquePhysicalFileBytes: 0,
      overlappingReferenceBytes: 0,
      multiplyReferencedPhysicalBytes: 0,
      referencedSectors: 0,
      unreferencedSectors: 0,
      ordinaryOwnedSectors: 0,
      streamOwnedSectors: 0,
    },
    structuralSectors: {
      systemArea: 0,
      discMetadata: 0,
      filesystemTable: 0,
      gameDirectoryTable: 0,
    },
    sectorRanges: [],
  };
}

function structuralCounterName(kind) {
  return {
    'system-area': 'systemArea',
    'disc-metadata': 'discMetadata',
    'filesystem-table': 'filesystemTable',
    'game-directory-table': 'gameDirectoryTable',
  }[kind];
}

function finalizeFileState(state) {
  state.record.payloadSha256 = state.payloadHash.digest('hex');
  state.record.rawSectorSha256 = state.rawSectorHash.digest('hex');
  state.record.probe = probePayload(
    state.prefix.subarray(0, state.prefixLength),
    state.record.knownUses,
  );
}

function validateMode2Header(header, sector) {
  if (header[15] !== 2) {
    throw new XenoFormatError('Catalog encountered a non-Mode-2 sector', 'INVALID_SECTOR_LAYOUT', {
      sector,
      mode: header[15],
    });
  }
  if (!header.subarray(16, 20).equals(header.subarray(20, 24))) {
    throw new XenoFormatError('Mode-2 sector subheaders do not match', 'INVALID_SECTOR_LAYOUT', {
      sector,
    });
  }
}

function isStreamSector(header) {
  return header[16] !== 0 || header[17] !== 0 || (header[18] & 0x40) !== 0;
}

function detectStorageLayouts(imagePath, disc, fileRecords) {
  const header = Buffer.alloc(24);
  const fileDescriptor = fs.openSync(imagePath, 'r');
  try {
    for (const record of fileRecords) {
      if (record.recordType !== 'file') continue;
      if (!Number.isInteger(record.sector) || record.sector < 0 || record.sector >= disc.sectorCount) {
        throw new XenoFormatError('Catalog file starts outside the disc image', 'INVALID_DISC_FILE', {
          flatIndex: record.flatIndex,
          sector: record.sector,
        });
      }
      if (record.logicalBytes === 0) {
        record.storageLayout = 'empty';
        continue;
      }

      const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, record.sector * SECTOR_SIZE);
      if (bytesRead !== header.length) {
        throw new XenoFormatError('Disc sector header is truncated', 'TRUNCATED_DISC_IMAGE', {
          sector: record.sector,
          bytesRead,
        });
      }
      validateMode2Header(header, record.sector);

      if (isStreamSector(header)) {
        if (record.logicalBytes % (SECTOR_SIZE - 16) !== 0) {
          throw new XenoFormatError('Stream file size is not aligned to its Mode-2 sector body', 'INVALID_DISC_FILE', {
            flatIndex: record.flatIndex,
            size: record.logicalBytes,
          });
        }
        record.storageLayout = 'mode2-stream';
        record.sectorPayloadOffset = 16;
        record.sectorPayloadBytes = SECTOR_SIZE - 16;
        record.streamFileNumber = header[16];
        record.streamChannelNumber = header[17];
      } else {
        record.storageLayout = 'ordinary';
        record.sectorPayloadOffset = SECTOR_DATA_OFFSET;
        record.sectorPayloadBytes = SECTOR_DATA_SIZE;
        record.streamFileNumber = null;
        record.streamChannelNumber = null;
      }
      record.allocatedSectors = Math.ceil(record.logicalBytes / record.sectorPayloadBytes);
      record.allocatedRawBytes = record.allocatedSectors * SECTOR_SIZE;
      if (record.sector + record.allocatedSectors > disc.sectorCount) {
        throw new XenoFormatError('Catalog file entry is outside the disc image', 'INVALID_DISC_FILE', {
          flatIndex: record.flatIndex,
          sector: record.sector,
          size: record.logicalBytes,
        });
      }
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function updateCoverage(coverage, bytes, known) {
  coverage.occurrence += bytes;
  if (bytes >= coverage.largest) {
    coverage.second = coverage.largest;
    coverage.largest = bytes;
  } else if (bytes > coverage.second) {
    coverage.second = bytes;
  }
  if (known) coverage.known = Math.max(coverage.known, bytes);
}

function emptyCoverage() {
  return { occurrence: 0, largest: 0, second: 0, known: 0 };
}

function appendSectorRange(ranges, classification, sector) {
  const current = ranges.at(-1);
  if (current?.classification === classification && current.endSector === sector) {
    current.endSector += 1;
    current.sectorCount += 1;
    return;
  }
  ranges.push({
    classification,
    startSector: sector,
    endSector: sector + 1,
    sectorCount: 1,
  });
}

function scanImage(imagePath, disc, fileRecords) {
  detectStorageLayouts(imagePath, disc, fileRecords);
  const startsBySector = new Map();
  const active = new Set();
  const accounting = makeAccounting();
  const imageHash = crypto.createHash('sha256');

  for (const record of fileRecords) {
    if (record.recordType !== 'file') continue;
    const state = {
      record,
      remaining: record.logicalBytes,
      payloadHash: crypto.createHash('sha256'),
      rawSectorHash: crypto.createHash('sha256'),
      prefix: Buffer.alloc(Math.min(HASH_PREFIX_BYTES, record.logicalBytes)),
      prefixLength: 0,
    };
    if (record.logicalBytes === 0) {
      finalizeFileState(state);
      continue;
    }
    if (!startsBySector.has(record.sector)) startsBySector.set(record.sector, []);
    startsBySector.get(record.sector).push(state);
  }

  const batch = Buffer.allocUnsafe(SECTOR_SIZE * READ_BATCH_SECTORS);
  const fileDescriptor = fs.openSync(imagePath, 'r');
  try {
    for (let firstSector = 0; firstSector < disc.sectorCount; firstSector += READ_BATCH_SECTORS) {
      const sectorCount = Math.min(READ_BATCH_SECTORS, disc.sectorCount - firstSector);
      const batchBytes = sectorCount * SECTOR_SIZE;
      const bytesRead = fs.readSync(
        fileDescriptor,
        batch,
        0,
        batchBytes,
        firstSector * SECTOR_SIZE,
      );
      if (bytesRead !== batchBytes) {
        throw new XenoFormatError('Disc image ended during catalog scan', 'TRUNCATED_DISC_IMAGE', {
          firstSector,
          expectedBytes: batchBytes,
          bytesRead,
        });
      }
      imageHash.update(batch.subarray(0, batchBytes));

      for (let batchIndex = 0; batchIndex < sectorCount; batchIndex += 1) {
        const sector = firstSector + batchIndex;
        const sectorOffset = batchIndex * SECTOR_SIZE;
        const rawSector = batch.subarray(sectorOffset, sectorOffset + SECTOR_SIZE);
        validateMode2Header(rawSector, sector);

        const structuralKind = structuralSectorKind(sector);
        if (structuralKind !== null) {
          accounting.structuralSectors[structuralCounterName(structuralKind)] += 1;
        }
        const form2 = (rawSector[18] & FORM2_FLAG) !== 0;
        accounting.sectorLayout.headerBytes += 16;
        accounting.sectorLayout.subheaderBytes += 8;
        accounting.physicalBytes.sectorHeaderBytes += 16;
        if (form2) {
          accounting.sectorLayout.mode2Form2Sectors += 1;
          accounting.sectorLayout.form2UserBytes += FORM2_DATA_SIZE;
          accounting.sectorLayout.form2IntegrityBytes += SECTOR_SIZE - SECTOR_DATA_OFFSET - FORM2_DATA_SIZE;
        } else {
          accounting.sectorLayout.mode2Form1Sectors += 1;
          accounting.sectorLayout.form1UserBytes += SECTOR_DATA_SIZE;
          accounting.sectorLayout.form1IntegrityBytes += SECTOR_SIZE - SECTOR_DATA_OFFSET - SECTOR_DATA_SIZE;
        }

        for (const state of startsBySector.get(sector) ?? []) active.add(state);
        const payload = rawSector.subarray(SECTOR_DATA_OFFSET, SECTOR_DATA_OFFSET + SECTOR_DATA_SIZE);
        const ordinaryCoverage = emptyCoverage();
        const streamCoverage = emptyCoverage();

        for (const state of active) {
          const stream = state.record.storageLayout === 'mode2-stream';
          if (stream && !isStreamSector(rawSector)) {
            throw new XenoFormatError('Stream allocation contains a non-stream sector', 'INVALID_DISC_FILE', {
              flatIndex: state.record.flatIndex,
              sector,
            });
          }
          const sectorPayload = stream
            ? rawSector.subarray(16, SECTOR_SIZE)
            : payload;
          const bytes = Math.min(state.record.sectorPayloadBytes, state.remaining);
          state.payloadHash.update(sectorPayload.subarray(0, bytes));
          state.rawSectorHash.update(rawSector);
          if (state.prefixLength < state.prefix.length) {
            const prefixBytes = Math.min(bytes, state.prefix.length - state.prefixLength);
            sectorPayload.copy(state.prefix, state.prefixLength, 0, prefixBytes);
            state.prefixLength += prefixBytes;
          }
          state.remaining -= bytes;
          updateCoverage(
            stream ? streamCoverage : ordinaryCoverage,
            bytes,
            state.record.classification === 'known',
          );
          if (state.remaining === 0) {
            finalizeFileState(state);
            active.delete(state);
          }
        }

        if (ordinaryCoverage.largest > 0 && streamCoverage.largest > 0) {
          throw new XenoFormatError('Ordinary and stream file allocations overlap', 'INVALID_DISC_ACCOUNTING', {
            sector,
          });
        }
        const coverage = streamCoverage.largest > 0 ? streamCoverage : ordinaryCoverage;
        accounting.references.logicalOccurrenceBytes += coverage.occurrence;
        accounting.references.overlappingReferenceBytes += coverage.occurrence - coverage.largest;
        accounting.references.multiplyReferencedPhysicalBytes += coverage.second;
        accounting.references.uniquePhysicalFileBytes += coverage.largest;
        if (streamCoverage.largest > 0) {
          accounting.references.referencedSectors += 1;
          accounting.references.streamOwnedSectors += 1;
          accounting.physicalBytes.knownFileContentBytes += streamCoverage.known;
          accounting.physicalBytes.unresolvedFileContentBytes += streamCoverage.largest - streamCoverage.known;
          appendSectorRange(accounting.sectorRanges, 'stream-file', sector);
        } else {
          accounting.physicalBytes.ordinarySubheaderBytes += 8;
          accounting.physicalBytes.ordinaryIntegrityBytes += form2 ? 4 : 280;
          if (ordinaryCoverage.largest > 0) {
            accounting.references.referencedSectors += 1;
            accounting.references.ordinaryOwnedSectors += 1;
            accounting.physicalBytes.knownFileContentBytes += ordinaryCoverage.known;
            accounting.physicalBytes.unresolvedFileContentBytes += ordinaryCoverage.largest - ordinaryCoverage.known;
            const tail = payload.subarray(ordinaryCoverage.largest);
            if (allZero(tail)) {
              accounting.physicalBytes.fileTailZeroPaddingBytes += tail.length;
            } else {
              accounting.physicalBytes.fileTailUnresolvedBytes += tail.length;
            }
            appendSectorRange(accounting.sectorRanges, 'ordinary-file', sector);
          } else {
            accounting.references.unreferencedSectors += 1;
            if (structuralKind !== null) {
              accounting.physicalBytes.structuralPayloadBytes += payload.length;
              appendSectorRange(accounting.sectorRanges, structuralKind, sector);
            } else if (allZero(payload)) {
              accounting.physicalBytes.unreferencedZeroPaddingBytes += payload.length;
            } else {
              accounting.physicalBytes.unreferencedUnresolvedBytes += payload.length;
            }
          }

          if (form2) {
            const extra = rawSector.subarray(
              SECTOR_DATA_OFFSET + SECTOR_DATA_SIZE,
              SECTOR_DATA_OFFSET + FORM2_DATA_SIZE,
            );
            if (structuralKind !== null && ordinaryCoverage.largest === 0) {
              accounting.physicalBytes.form2ExtendedStructuralBytes += extra.length;
            } else if (allZero(extra)) {
              accounting.physicalBytes.form2ExtendedZeroPaddingBytes += extra.length;
            } else {
              accounting.physicalBytes.form2ExtendedUnresolvedBytes += extra.length;
            }
          }
          if (ordinaryCoverage.largest === 0 && structuralKind === null) {
            const extra = form2
              ? rawSector.subarray(
                SECTOR_DATA_OFFSET + SECTOR_DATA_SIZE,
                SECTOR_DATA_OFFSET + FORM2_DATA_SIZE,
              )
              : Buffer.alloc(0);
            appendSectorRange(
              accounting.sectorRanges,
              allZero(payload) && allZero(extra) ? 'zero-padding' : 'unresolved-unreferenced',
              sector,
            );
          }
        }
      }
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }

  if (active.size !== 0) {
    throw new XenoFormatError('Catalog scan ended with incomplete file records', 'TRUNCATED_DISC_IMAGE', {
      activeFiles: active.size,
    });
  }
  return { accounting, imageSha256: imageHash.digest('hex') };
}

function findDuplicates(files) {
  const byPayload = new Map();
  for (const file of files) {
    if (file.recordType !== 'file') continue;
    const key = `${file.logicalBytes}:${file.payloadSha256}`;
    if (!byPayload.has(key)) byPayload.set(key, []);
    byPayload.get(key).push(file);
  }

  const groups = [];
  let duplicateLogicalBytes = 0;
  for (const occurrences of byPayload.values()) {
    if (occurrences.length < 2) continue;
    occurrences.sort((left, right) => left.flatIndex - right.flatIndex);
    const canonical = occurrences[0];
    for (const duplicate of occurrences.slice(1)) {
      duplicate.duplicateOf = canonical.id;
      duplicateLogicalBytes += duplicate.logicalBytes;
    }
    groups.push({
      payloadSha256: canonical.payloadSha256,
      logicalBytes: canonical.logicalBytes,
      canonicalId: canonical.id,
      occurrenceIds: occurrences.map((file) => file.id),
    });
  }
  groups.sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
  return {
    groups,
    duplicateLogicalBytes,
    uniquePayloadCount: byPayload.size,
  };
}

function sumValues(value) {
  return Object.values(value).reduce((total, item) => total + item, 0);
}

export function buildDiscCatalog(imagePath) {
  const { disc, root, filesystemTable } = readDiscFilesystem(imagePath);
  const flatUses = knownUsesByFlatIndex(imagePath, disc.discNumber);
  const { directories, files } = flattenFilesystem(root, disc.discNumber, flatUses);
  const { accounting, imageSha256 } = scanImage(imagePath, disc, files);
  const duplicates = findDuplicates(files);
  const readableFiles = files.filter((file) => file.recordType === 'file');
  const rawAccountedBytes = sumValues(accounting.physicalBytes);
  const layoutAccountedBytes = accounting.sectorLayout.headerBytes
    + accounting.sectorLayout.subheaderBytes
    + accounting.sectorLayout.form1UserBytes
    + accounting.sectorLayout.form1IntegrityBytes
    + accounting.sectorLayout.form2UserBytes
    + accounting.sectorLayout.form2IntegrityBytes;
  const logicalOccurrenceBytes = readableFiles.reduce(
    (total, file) => total + file.logicalBytes,
    0,
  );

  if (layoutAccountedBytes !== disc.bytes
    || rawAccountedBytes !== disc.bytes
    || logicalOccurrenceBytes !== accounting.references.logicalOccurrenceBytes) {
    throw new XenoFormatError('Disc catalog byte accounting is inconsistent', 'INVALID_DISC_ACCOUNTING', {
      layoutAccountedBytes,
      rawAccountedBytes,
      rawBytes: disc.bytes,
      logicalOccurrenceBytes,
      scannedOccurrenceBytes: accounting.references.logicalOccurrenceBytes,
    });
  }

  const catalog = {
    schemaVersion: DISC_CATALOG_SCHEMA_VERSION,
    source: {
      discNumber: disc.discNumber,
      bytes: disc.bytes,
      sectorCount: disc.sectorCount,
      sectorSize: SECTOR_SIZE,
      primaryPayloadSize: SECTOR_DATA_SIZE,
      imageSha256,
    },
    filesystemTable,
    summary: {
      directoryCount: directories.length - 1,
      readableFileCount: readableFiles.length,
      paddingMarkerCount: files.length - readableFiles.length,
      positiveSizeFileCount: readableFiles.filter((file) => file.logicalBytes > 0).length,
      zeroSizeFileCount: readableFiles.filter((file) => file.logicalBytes === 0).length,
      ordinaryFileCount: readableFiles.filter((file) => file.storageLayout === 'ordinary').length,
      streamFileCount: readableFiles.filter((file) => file.storageLayout === 'mode2-stream').length,
      knownFileCount: readableFiles.filter((file) => file.classification === 'known').length,
      unresolvedFileCount: readableFiles.filter((file) => file.classification === 'unresolved').length,
      logicalOccurrenceBytes,
      uniquePayloadCount: duplicates.uniquePayloadCount,
      duplicateGroupCount: duplicates.groups.length,
      duplicateOccurrenceCount: readableFiles.filter((file) => file.duplicateOf !== null).length,
      duplicateLogicalBytes: duplicates.duplicateLogicalBytes,
      rawAccountedBytes,
    },
    accounting,
    directories,
    files,
    duplicateGroups: duplicates.groups,
  };

  return {
    ...catalog,
    catalogSha256: sha256(JSON.stringify(catalog)),
  };
}
