import fs from 'node:fs';
import path from 'node:path';

import { extractFlatDiscFiles } from './disc-index.js';

const FIELD_NAMES = [
  'Fei',
  'Elly',
  'Citan',
  'Bart',
  'Billy',
  'Rico',
  'Emeralda',
  'Chu-Chu',
  'Maria',
  'Citan (Sword)',
  'Emeralda (Adult)',
  'Margie',
  'Fei Variant 1',
  'Fei Variant 2',
  'Fei Variant 3',
  'Fei Variant 4',
  'Weltall',
  'Weltall-2',
  'Vierge',
  'Heimdal',
  'Brigandier',
  'Renmazuo',
  'Stier',
  'Chu-Chu Gear',
  'Siebzehn',
  'Crescens',
  'Vierge Variant',
  'El-Fenrir',
  'El-Andvari',
  'El-Renmazuo',
  'El-Stier',
  'Xenogears',
  'Heimdal (Sword)',
];

function range(start, end, step = 1) {
  const values = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

function definitions(category, indexes, nameForIndex, compression = null) {
  return indexes.map((flatIndex, index) => ({
    id: `${category}-${flatIndex}`,
    category,
    flatIndex,
    name: nameForIndex(index, flatIndex),
    compression,
  }));
}

export const SPRITE_RESOURCE_DEFINITIONS = Object.freeze([
  ...definitions('field', range(427, 459), (index) => FIELD_NAMES[index], 'lzs'),
  ...definitions('cutscene', range(2336, 2456), (index) => `Cutscene sprite ${index + 1}`),
  ...definitions('enemy', range(2619, 2769, 2), (index) => `Battle enemy ${index + 1}`),
  ...definitions('party', range(2988, 3017), (index) => `Party battle sprite ${index + 1}`),
  ...definitions('effect', range(3381, 3914), (index) => `Battle effect ${index + 1}`),
  ...definitions('overworld-character', range(3922, 3937), (index) => `Overworld character ${index + 1}`),
  ...definitions('overworld-gear', range(3939, 3955), (index) => `Overworld Gear ${index + 1}`),
]);

export const SHARED_BATTLE_SPRITE_TEXTURE_FLAT_INDEX = 3080;
export const SHARED_BATTLE_SPRITE_FLAT_INDEX = 3081;

const DEFINITIONS_BY_ID = new Map(SPRITE_RESOURCE_DEFINITIONS.map((definition) => [definition.id, definition]));

export function getSpriteResourceDefinition(spriteId) {
  return DEFINITIONS_BY_ID.get(spriteId) || null;
}

export function getSpriteResourcePath(resourcesDir, definitionOrId) {
  const definition = typeof definitionOrId === 'string'
    ? getSpriteResourceDefinition(definitionOrId)
    : definitionOrId;
  if (!definition) throw new RangeError('Unknown sprite resource');
  return path.join(resourcesDir, `${definition.flatIndex.toString().padStart(4, '0')}.bin`);
}

export function getSharedBattleSpriteResourcePath(resourcesDir) {
  return path.join(resourcesDir, `${SHARED_BATTLE_SPRITE_FLAT_INDEX}.bin`);
}

export function getSharedBattleSpriteTexturePath(resourcesDir) {
  return path.join(resourcesDir, `${SHARED_BATTLE_SPRITE_TEXTURE_FLAT_INDEX}.bin`);
}

export function discoverSpriteResourceFiles(resourcesDir) {
  return SPRITE_RESOURCE_DEFINITIONS.map((definition) => {
    const resourcePath = getSpriteResourcePath(resourcesDir, definition);
    const available = fs.existsSync(resourcePath);
    return {
      ...definition,
      available,
      resourcePath,
      bytes: available ? fs.statSync(resourcePath).size : 0,
    };
  });
}

export function extractSpriteResourceFiles({ imagePath, outputDir, onProgress = () => {} }) {
  return extractFlatDiscFiles({
    imagePath,
    outputDir,
    flatIndexes: [
      ...SPRITE_RESOURCE_DEFINITIONS.map((definition) => definition.flatIndex),
      SHARED_BATTLE_SPRITE_TEXTURE_FLAT_INDEX,
      SHARED_BATTLE_SPRITE_FLAT_INDEX,
    ],
    label: 'sprite resource',
    onProgress,
  });
}
