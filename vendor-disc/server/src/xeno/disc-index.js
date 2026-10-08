import fs from 'node:fs';
import path from 'node:path';

import { XenoFormatError } from './binary-reader.js';

export const SECTOR_SIZE = 2352;
export const SECTOR_DATA_OFFSET = 24;
export const SECTOR_DATA_SIZE = 2048;
export const DISC_SECTOR_COUNTS = new Map([
  [305586, 1],
  [292815, 2],
]);

const DISC_IDENTIFIERS = new Map([
  ['DS01_XENOGEARS', 1],
  ['DS02_XENOGEARS', 2],
]);
const FIELD_DIRECTORY_ORDINAL = 12;
const SCENE_MODEL_DIRECTORY_ORDINAL = 13;
const GAME_DIRECTORY_TABLE_SECTOR = 0x28;
const GAME_DIRECTORY_COUNT = 0x7a / 2;
const WORLDMAP_DIRECTORY = 0x24;

export const WORLDMAP_CONFIG_BASES = Object.freeze([
  0x2b,
  0x36,
  0x41,
  0x4c,
  0x57,
  0x62,
  0x6d,
  0x78,
  0x83,
]);

function readExact(fileDescriptor, length, position, label) {
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = fs.readSync(fileDescriptor, buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new XenoFormatError(`${label} is truncated`, 'TRUNCATED_DISC_IMAGE', {
      position,
      expectedBytes: length,
      bytesRead,
    });
  }
  return buffer;
}

function readSectorPayload(fileDescriptor, sectorNumber) {
  return readExact(
    fileDescriptor,
    SECTOR_DATA_SIZE,
    sectorNumber * SECTOR_SIZE + SECTOR_DATA_OFFSET,
    `disc sector ${sectorNumber}`,
  );
}

export function validateDiscImage(imagePath) {
  const stat = fs.statSync(imagePath);
  if (!stat.isFile()) {
    throw new XenoFormatError('Disc image path is not a file', 'INVALID_DISC_IMAGE', { imagePath });
  }

  if (stat.size % SECTOR_SIZE !== 0) {
    throw new XenoFormatError('Disc image does not use 2,352-byte raw sectors', 'INVALID_SECTOR_LAYOUT', {
      imagePath,
      bytes: stat.size,
    });
  }

  const sectorCount = stat.size / SECTOR_SIZE;
  const sizeDiscNumber = DISC_SECTOR_COUNTS.get(sectorCount);
  if (!sizeDiscNumber) {
    throw new XenoFormatError('Disc image has an unexpected sector count', 'INVALID_SECTOR_COUNT', {
      imagePath,
      sectorCount,
    });
  }

  const fileDescriptor = fs.openSync(imagePath, 'r');
  try {
    const bootPayload = readSectorPayload(fileDescriptor, 16);
    if (bootPayload.toString('ascii', 0x28, 0x28 + 9) !== 'XENOGEARS') {
      throw new XenoFormatError('Disc boot record is not Xenogears', 'INVALID_BOOT_RECORD', { imagePath });
    }

    const discPayload = readSectorPayload(fileDescriptor, 23);
    const identifier = discPayload.toString('ascii', 0, 14);
    const discNumber = DISC_IDENTIFIERS.get(identifier);
    if (!discNumber || discNumber !== sizeDiscNumber) {
      throw new XenoFormatError('Disc identification record is invalid', 'INVALID_DISC_IDENTIFIER', {
        imagePath,
        identifier,
        sectorCount,
      });
    }

    return {
      discNumber,
      path: path.resolve(imagePath),
      fileName: path.basename(imagePath),
      bytes: stat.size,
      sectorCount,
    };
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function scanDiscImages(discImagesDir) {
  if (!fs.existsSync(discImagesDir)) {
    return { discs: [], invalidImages: [] };
  }

  const candidates = fs.readdirSync(discImagesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.bin')
    .map((entry) => path.join(discImagesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const discs = [];
  const invalidImages = [];

  for (const candidate of candidates) {
    try {
      discs.push(validateDiscImage(candidate));
    } catch (error) {
      invalidImages.push({
        fileName: path.basename(candidate),
        code: error.code || 'INVALID_DISC_IMAGE',
        message: error.message,
      });
    }
  }

  return { discs, invalidImages };
}

function parseDirectory(entries, state) {
  const directoryEntry = entries[state.index];
  if (!directoryEntry || directoryEntry.size >= 0) {
    throw new XenoFormatError('Invalid directory entry in disc filesystem', 'INVALID_DISC_FILESYSTEM', {
      entryIndex: state.index,
    });
  }

  state.index += 1;
  const directoryEnd = state.index + -directoryEntry.size;
  if (directoryEnd > entries.length) {
    throw new XenoFormatError('Disc directory extends beyond the filesystem table', 'INVALID_DISC_FILESYSTEM', {
      directoryEnd,
      entryCount: entries.length,
    });
  }

  const directory = {
    ordinal: state.nextDirectoryOrdinal,
    flatIndex: directoryEntry.flatIndex,
    sector: directoryEntry.sector,
    entryCount: -directoryEntry.size,
    directories: [],
    files: [],
  };
  state.nextDirectoryOrdinal += 1;

  while (state.index < directoryEnd) {
    const entry = entries[state.index];
    if (entry.size < 0) {
      directory.directories.push(parseDirectory(entries, state));
    } else {
      directory.files.push(entry);
      state.index += 1;
    }
  }

  if (state.index !== directoryEnd) {
    throw new XenoFormatError('Disc directory entry count is inconsistent', 'INVALID_DISC_FILESYSTEM', {
      expectedEnd: directoryEnd,
      actualEnd: state.index,
    });
  }

  return directory;
}

function parseFilesystemEntries(tableBuffer) {
  const entries = [];
  for (let offset = 0; offset + 7 <= tableBuffer.length; offset += 7) {
    const sector = tableBuffer[offset] | (tableBuffer[offset + 1] << 8) | (tableBuffer[offset + 2] << 16);
    if (sector === 0) {
      continue;
    }
    entries.push({
      flatIndex: offset / 7,
      sector,
      size: tableBuffer.readInt32LE(offset + 3),
    });
  }
  return entries;
}

function readFilesystemTable(fileDescriptor) {
  const table = Buffer.alloc(16 * SECTOR_DATA_SIZE);
  for (let sectorIndex = 0; sectorIndex < 16; sectorIndex += 1) {
    readSectorPayload(fileDescriptor, 24 + sectorIndex).copy(table, sectorIndex * SECTOR_DATA_SIZE);
  }
  return table;
}

export function readDiscFilesystem(imagePath) {
  const disc = validateDiscImage(imagePath);
  const fileDescriptor = fs.openSync(imagePath, 'r');

  try {
    const table = readFilesystemTable(fileDescriptor);
    const entries = parseFilesystemEntries(table);
    const root = { ordinal: 0, directories: [], files: [] };
    const state = { index: 0, nextDirectoryOrdinal: 1 };

    while (state.index < entries.length) {
      const entry = entries[state.index];
      if (entry.size < 0) {
        root.directories.push(parseDirectory(entries, state));
      } else {
        root.files.push(entry);
        state.index += 1;
      }
    }

    const tableSlotCount = Math.floor(table.length / 7);
    return {
      disc,
      root,
      filesystemTable: {
        firstSector: 24,
        sectorCount: 16,
        bytes: table.length,
        slotCount: tableSlotCount,
        populatedSlotCount: entries.length,
        emptySlotCount: tableSlotCount - entries.length,
        trailingBytes: table.length - tableSlotCount * 7,
      },
    };
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function extractFlatDiscFiles({
  imagePath,
  outputDir,
  flatIndexes,
  label = 'resource',
  fileNameForEntry = (entry) => `${entry.flatIndex.toString().padStart(4, '0')}.bin`,
  onProgress = () => {},
}) {
  if (!Array.isArray(flatIndexes) || flatIndexes.length === 0) {
    throw new TypeError('At least one flat disc file index is required');
  }

  const disc = validateDiscImage(imagePath);
  const fileDescriptor = fs.openSync(imagePath, 'r');

  try {
    const entries = parseFilesystemEntries(readFilesystemTable(fileDescriptor));
    const entriesByIndex = new Map(entries.map((entry) => [entry.flatIndex, entry]));
    const selectedIndexes = [...new Set(flatIndexes)].sort((left, right) => left - right);
    const selected = selectedIndexes.map((flatIndex) => {
      if (!Number.isInteger(flatIndex) || flatIndex < 0) {
        throw new RangeError(`Invalid flat disc file index: ${flatIndex}`);
      }
      const entry = entriesByIndex.get(flatIndex);
      if (!entry || entry.size < 0 || entry.sector === 0xffffff) {
        throw new XenoFormatError('Flat disc index is not a readable file', 'INVALID_DISC_FILE_INDEX', {
          flatIndex,
        });
      }
      return entry;
    });

    fs.mkdirSync(outputDir, { recursive: true });
    const totalBytes = selected.reduce((total, entry) => total + entry.size, 0);
    let completedBytes = 0;

    selected.forEach((entry, index) => {
      const contents = readDiscFile(fileDescriptor, entry, disc.sectorCount);
      const fileName = fileNameForEntry(entry);
      if (typeof fileName !== 'string' || !/^\d{4}\.bin$/i.test(fileName)) {
        throw new TypeError(`Invalid extracted resource file name: ${fileName}`);
      }
      fs.writeFileSync(path.join(outputDir, fileName), contents);
      completedBytes += contents.length;
      if (index % 10 === 0 || index + 1 === selected.length) {
        onProgress({
          completed: index + 1,
          total: selected.length,
          completedBytes,
          totalBytes,
          message: `Extracted ${index + 1} of ${selected.length} ${label} files`,
        });
      }
    });

    return {
      discNumber: disc.discNumber,
      resourceDir: path.resolve(outputDir),
      fileCount: selected.length,
      totalBytes,
      firstFlatIndex: selected[0].flatIndex,
      lastFlatIndex: selected.at(-1).flatIndex,
    };
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function findDirectory(directory, ordinal) {
  if (directory.ordinal === ordinal) {
    return directory;
  }
  for (const child of directory.directories) {
    const match = findDirectory(child, ordinal);
    if (match) return match;
  }
  return null;
}

function readDiscFile(fileDescriptor, file, sectorCount) {
  const requiredSectors = Math.ceil(file.size / SECTOR_DATA_SIZE);
  if (file.size < 0 || file.sector + requiredSectors > sectorCount) {
    throw new XenoFormatError('Disc file entry is outside the image', 'INVALID_DISC_FILE', file);
  }

  const output = Buffer.alloc(file.size);
  for (let sectorIndex = 0; sectorIndex < requiredSectors; sectorIndex += 1) {
    const payload = readSectorPayload(fileDescriptor, file.sector + sectorIndex);
    const outputOffset = sectorIndex * SECTOR_DATA_SIZE;
    payload.copy(output, outputOffset, 0, Math.min(SECTOR_DATA_SIZE, file.size - outputOffset));
  }
  return output;
}

function extractDirectory({
  imagePath,
  outputDir,
  directoryOrdinal,
  expectedDiscOneFiles,
  label,
  onProgress,
}) {
  const { disc, root } = readDiscFilesystem(imagePath);
  const directory = findDirectory(root, directoryOrdinal);
  if (!directory) {
    throw new XenoFormatError(`${label} directory was not found`, 'RESOURCE_DIRECTORY_NOT_FOUND', {
      imagePath,
      directoryOrdinal,
    });
  }

  const files = [];
  for (const file of directory.files) {
    if (file.sector === 0xffffff) break;
    files.push(file);
  }

  if (disc.discNumber === 1 && files.length !== expectedDiscOneFiles) {
    throw new XenoFormatError(`Disc 1 ${label} directory has an unexpected file count`, 'INVALID_RESOURCE_DIRECTORY', {
      expected: expectedDiscOneFiles,
      actual: files.length,
      directoryOrdinal,
    });
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const fileDescriptor = fs.openSync(imagePath, 'r');
  let completedBytes = 0;
  const totalBytes = files.reduce((total, file) => total + file.size, 0);

  try {
    files.forEach((file, fileIndex) => {
      const contents = readDiscFile(fileDescriptor, file, disc.sectorCount);
      const fileName = `${fileIndex.toString().padStart(4, '0')}.bin`;
      fs.writeFileSync(path.join(outputDir, fileName), contents);
      completedBytes += contents.length;

      if (fileIndex % 10 === 0 || fileIndex + 1 === files.length) {
        onProgress({
          completed: fileIndex + 1,
          total: files.length,
          completedBytes,
          totalBytes,
          message: `Extracted ${fileIndex + 1} of ${files.length} ${label} files`,
        });
      }
    });
  } finally {
    fs.closeSync(fileDescriptor);
  }

  return {
    discNumber: disc.discNumber,
    resourceDir: path.resolve(outputDir),
    fileCount: files.length,
    totalBytes,
  };
}

export function extractFieldDirectory({ imagePath, outputDir, onProgress = () => {} }) {
  return extractDirectory({
    imagePath,
    outputDir,
    directoryOrdinal: FIELD_DIRECTORY_ORDINAL,
    expectedDiscOneFiles: 1460,
    label: 'field',
    onProgress,
  });
}

export function extractSceneModelDirectory({ imagePath, outputDir, onProgress = () => {} }) {
  return extractDirectory({
    imagePath,
    outputDir,
    directoryOrdinal: SCENE_MODEL_DIRECTORY_ORDINAL,
    expectedDiscOneFiles: 145,
    label: 'scene-model',
    onProgress,
  });
}

function readGameDirectoryTable(fileDescriptor) {
  const payload = readSectorPayload(fileDescriptor, GAME_DIRECTORY_TABLE_SECTOR);
  return Array.from(
    { length: GAME_DIRECTORY_COUNT },
    (_, index) => payload.readInt16LE(index * 2),
  );
}

export function getWorldmapFileIndexMap(imagePath) {
  validateDiscImage(imagePath);
  const fileDescriptor = fs.openSync(imagePath, 'r');
  try {
    const firstFileIndex = readGameDirectoryTable(fileDescriptor)[WORLDMAP_DIRECTORY];
    if (!Number.isInteger(firstFileIndex) || firstFileIndex < 1) {
      throw new XenoFormatError('World-map directory was not found', 'RESOURCE_DIRECTORY_NOT_FOUND', {
        imagePath,
        directory: WORLDMAP_DIRECTORY,
      });
    }

    return new Map(WORLDMAP_CONFIG_BASES.flatMap((baseFileId) => (
      Array.from({ length: 10 }, (_, offset) => {
        const localFileId = baseFileId + offset + 1;
        return [localFileId, firstFileIndex + localFileId - 2];
      })
    )));
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function extractWorldmapFiles({ imagePath, outputDir, onProgress = () => {} }) {
  const indexMap = getWorldmapFileIndexMap(imagePath);
  const localByFlatIndex = new Map([...indexMap].map(([localFileId, flatIndex]) => [flatIndex, localFileId]));
  return extractFlatDiscFiles({
    imagePath,
    outputDir,
    flatIndexes: [...localByFlatIndex.keys()],
    label: 'overworld',
    fileNameForEntry(entry) {
      return `${localByFlatIndex.get(entry.flatIndex).toString().padStart(4, '0')}.bin`;
    },
    onProgress,
  });
}

export function findDiscImage(discImagesDir, discNumber) {
  const { discs } = scanDiscImages(discImagesDir);
  const matches = discs.filter((disc) => disc.discNumber === discNumber);
  if (matches.length === 0) {
    throw new XenoFormatError(`Xenogears Disc ${discNumber} was not found`, 'DISC_NOT_FOUND', {
      discImagesDir,
      discNumber,
    });
  }
  if (matches.length > 1) {
    throw new XenoFormatError(`More than one Xenogears Disc ${discNumber} image was found`, 'DUPLICATE_DISC_IMAGE', {
      discNumber,
      files: matches.map((disc) => disc.fileName),
    });
  }
  return matches[0];
}
