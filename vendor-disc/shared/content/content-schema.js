export const CONTENT_PACKAGE_SCHEMA_VERSION = 1;

export const CONTENT_FAMILIES = Object.freeze([
  'fields',
  'models',
  'sprites',
  'overworlds',
  'battle',
  'menu',
  'text',
  'fonts',
  'audio',
  'movies',
  'images',
]);

const FAMILY_SECTION_TYPES = Object.freeze({
  fields: Object.freeze({
    entries: 'array',
    environment: 'object',
    navigation: 'object',
    entities: 'array',
    programs: 'array',
    dialogue: 'array',
    encounters: 'array',
    transitions: 'array',
    cameras: 'array',
    effects: 'object',
  }),
  models: Object.freeze({
    geometry: 'object',
    hierarchy: 'object',
    materials: 'array',
    textures: 'array',
    animations: 'array',
    semantics: 'object',
    configuration: 'object',
  }),
  sprites: Object.freeze({
    frames: 'array',
    parts: 'array',
    palettes: 'array',
    animations: 'array',
    children: 'array',
    attachments: 'array',
    compositing: 'object',
    metrics: 'object',
  }),
  overworlds: Object.freeze({
    terrain: 'object',
    placements: 'array',
    models: 'array',
    navigation: 'object',
    exits: 'array',
    waves: 'object',
    configuration: 'object',
  }),
  battle: Object.freeze({
    formations: 'array',
    actors: 'array',
    gears: 'array',
    enemies: 'array',
    items: 'array',
    weapons: 'array',
    abilities: 'array',
    ai: 'array',
    events: 'array',
    arenas: 'array',
    cameras: 'array',
    effects: 'array',
    results: 'object',
    progression: 'object',
  }),
  menu: Object.freeze({
    menu: 'object',
    screens: 'array',
    layouts: 'array',
    items: 'array',
    equipment: 'array',
    shops: 'array',
    abilities: 'array',
    saves: 'object',
  }),
  text: Object.freeze({
    locale: 'string',
    entries: 'array',
    tokens: 'array',
    substitutions: 'array',
  }),
  fonts: Object.freeze({
    glyphs: 'array',
    palettes: 'array',
    metrics: 'object',
    layout: 'object',
  }),
  audio: Object.freeze({
    samples: 'array',
    sequences: 'array',
    playbackTimeline: 'object',
    instruments: 'array',
    cues: 'array',
    mix: 'object',
  }),
  movies: Object.freeze({
    video: 'object',
    audio: 'object',
    timing: 'object',
    subtitles: 'array',
    chapters: 'array',
  }),
  images: Object.freeze({
    image: 'object',
    palettes: 'array',
    views: 'array',
  }),
});

export const CONTENT_FAMILY_SCHEMAS = Object.freeze(Object.fromEntries(
  CONTENT_FAMILIES.map((family) => [family, Object.freeze({
    name: `xenogears-content-${family}`,
    version: 1,
    sections: FAMILY_SECTION_TYPES[family],
  })]),
));

export const CONTENT_FAMILY_SCHEMA_VERSIONS = Object.freeze(Object.fromEntries(
  CONTENT_FAMILIES.map((family) => [family, CONTENT_FAMILY_SCHEMAS[family].version]),
));

const FAMILY_SET = new Set(CONTENT_FAMILIES);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STABLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ASSET_ID_PATTERN = /^xg:(?:d[12]|shared):asset:[a-z0-9][a-z0-9:._-]*$/;
const SOURCE_ID_PATTERN = /^xg:d[12]:file-[0-9]{6}$/;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const AXIS_PATTERN = /^[+-][xyz]$/;
const FORBIDDEN_STRING_PATTERNS = [
  /(?:^|[\\/])local-data[\\/]source(?:[\\/]|$)/i,
  /(?:^|[\\/])resources[\\/]stripcd[12](?:[\\/]|$)/i,
  /^file:/i,
  /^https?:/i,
  /^\/api\//i,
  /(?:^|[\\/])\.\.(?:[\\/]|$)/,
  /^(?:\/|\\\\)/,
  /^[a-z]:[\\/]/i,
];
const ARTIFACT_EXTENSIONS = Object.freeze({
  'application/gzip': '.json.gz',
  'model/gltf-binary': '.glb',
  'image/png': '.png',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'video/webm': '.webm',
  'video/mp4': '.mp4',
});
const ARTIFACT_DIRECTORIES = Object.freeze({
  'application/gzip': CONTENT_FAMILIES,
  'model/gltf-binary': Object.freeze(['models']),
  'image/png': Object.freeze(['fields', 'models', 'sprites', 'overworlds', 'battle', 'menu', 'fonts', 'images']),
  'audio/wav': Object.freeze(['audio']),
  'audio/ogg': Object.freeze(['audio']),
  'audio/opus': Object.freeze(['audio']),
  'video/webm': Object.freeze(['movies']),
  'video/mp4': Object.freeze(['movies']),
});

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertExactKeys(value, required, optional, label) {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}.`);
  }
}

function assertStableName(value, label) {
  if (typeof value !== 'string' || !STABLE_NAME_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a stable lower-case name.`);
  }
}

function assertAssetId(value, label) {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a stable lower-case asset ID.`);
  }
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest.`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function assertPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number.`);
  }
}

function assertCleanString(value, label) {
  if (typeof value !== 'string' || FORBIDDEN_STRING_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new TypeError(`${label} contains a native path or runtime URL.`);
  }
}

export function assertContentPath(value, label = 'Content path') {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('//')
  ) {
    throw new TypeError(`${label} must be a package-relative POSIX path.`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !STABLE_NAME_PATTERN.test(segment) || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} contains an invalid segment.`);
  }
  assertCleanString(value, label);
  return value;
}

function assertFamily(value) {
  if (!FAMILY_SET.has(value)) throw new TypeError(`Unknown content family: ${value}.`);
}

function assertArtifactDescriptor(artifact) {
  assertExactKeys(
    artifact,
    ['role', 'path', 'mediaType', 'bytes', 'sha256'],
    [],
    'Content artifact',
  );
  assertStableName(artifact.role, 'Content artifact role');
  assertContentPath(artifact.path, 'Content artifact path');
  const extension = ARTIFACT_EXTENSIONS[artifact.mediaType];
  if (!extension || !artifact.path.endsWith(extension)) {
    throw new TypeError('Content artifact media type or extension is unsupported.');
  }
  const topDirectory = artifact.path.split('/')[0];
  if (!ARTIFACT_DIRECTORIES[artifact.mediaType].includes(topDirectory)) {
    throw new TypeError('Content artifact is outside the directories allowed for its media type.');
  }
  assertNonNegativeInteger(artifact.bytes, 'Content artifact byte length');
  assertHash(artifact.sha256, 'Content artifact hash');
}

function assertDependency(dependency) {
  assertExactKeys(dependency, ['id', 'role'], [], 'Content dependency');
  assertAssetId(dependency.id, 'Content dependency ID');
  assertStableName(dependency.role, 'Content dependency role');
}

function assertProvenance(provenance) {
  assertExactKeys(provenance, ['decoder', 'sources'], [], 'Content provenance');
  assertExactKeys(provenance.decoder, ['id', 'revision'], [], 'Content decoder');
  assertStableName(provenance.decoder.id, 'Content decoder ID');
  if (!Number.isSafeInteger(provenance.decoder.revision) || provenance.decoder.revision < 1) {
    throw new TypeError('Content decoder revision must be a positive integer.');
  }
  if (!Array.isArray(provenance.sources) || provenance.sources.length === 0) {
    throw new TypeError('Content provenance requires at least one source occurrence.');
  }
  for (const source of provenance.sources) {
    assertExactKeys(
      source,
      ['id', 'role', 'sha256', 'bytes', 'ranges'],
      [],
      'Content provenance source',
    );
    if (typeof source.id !== 'string' || !SOURCE_ID_PATTERN.test(source.id)) {
      throw new TypeError('Content provenance source ID is invalid.');
    }
    assertStableName(source.role, 'Content provenance source role');
    assertHash(source.sha256, 'Content provenance source hash');
    assertNonNegativeInteger(source.bytes, 'Content provenance source byte length');
    if (!Array.isArray(source.ranges) || source.ranges.length === 0) {
      throw new TypeError('Content provenance source requires at least one byte range.');
    }
    let previousEnd = 0;
    for (const range of source.ranges) {
      assertExactKeys(range, ['offset', 'length'], [], 'Content provenance source range');
      assertNonNegativeInteger(range.offset, 'Content provenance range offset');
      assertNonNegativeInteger(range.length, 'Content provenance range length');
      if (range.offset + range.length > source.bytes) {
        throw new TypeError('Content provenance range exceeds its source file.');
      }
      if (range.offset < previousEnd) {
        throw new TypeError('Content provenance ranges must be ordered and non-overlapping.');
      }
      previousEnd = range.offset + range.length;
    }
  }
}

function assertCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) throw new TypeError('Content coordinates must be an array.');
  for (const coordinate of coordinates) {
    assertExactKeys(
      coordinate,
      [
        'id',
        'handedness',
        'axes',
        'distanceUnit',
        'metersPerUnit',
        'rotationUnit',
        'unitsPerTurn',
        'presentationScale',
      ],
      [],
      'Content coordinate contract',
    );
    assertStableName(coordinate.id, 'Coordinate space ID');
    if (coordinate.handedness !== 'left' && coordinate.handedness !== 'right') {
      throw new TypeError('Coordinate handedness must be left or right.');
    }
    assertExactKeys(coordinate.axes, ['right', 'up', 'forward'], [], 'Coordinate axes');
    const axes = Object.values(coordinate.axes);
    if (axes.some((axis) => typeof axis !== 'string' || !AXIS_PATTERN.test(axis))) {
      throw new TypeError('Coordinate axes must use signed x, y, and z names.');
    }
    if (new Set(axes.map((axis) => axis[1])).size !== 3) {
      throw new TypeError('Coordinate axes must use each dimension exactly once.');
    }
    assertStableName(coordinate.distanceUnit, 'Coordinate distance unit');
    if (coordinate.metersPerUnit !== null) {
      assertPositiveNumber(coordinate.metersPerUnit, 'Coordinate metres per unit');
    }
    assertStableName(coordinate.rotationUnit, 'Coordinate rotation unit');
    if (coordinate.unitsPerTurn !== null) {
      assertPositiveNumber(coordinate.unitsPerTurn, 'Coordinate units per turn');
    }
    assertPositiveNumber(coordinate.presentationScale, 'Coordinate presentation scale');
  }
  const ids = coordinates.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new TypeError('Coordinate space IDs must be unique.');
}

function assertTiming(timing) {
  if (!Array.isArray(timing)) throw new TypeError('Content timing must be an array.');
  for (const clock of timing) {
    assertExactKeys(clock, ['id', 'ticksPerSecond'], [], 'Content timing contract');
    assertStableName(clock.id, 'Content timing clock ID');
    assertExactKeys(clock.ticksPerSecond, ['numerator', 'denominator'], [], 'Content timing rate');
    if (!Number.isSafeInteger(clock.ticksPerSecond.numerator) || clock.ticksPerSecond.numerator < 1) {
      throw new TypeError('Content timing numerator must be a positive integer.');
    }
    if (!Number.isSafeInteger(clock.ticksPerSecond.denominator) || clock.ticksPerSecond.denominator < 1) {
      throw new TypeError('Content timing denominator must be a positive integer.');
    }
  }
  const ids = timing.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new TypeError('Content timing clock IDs must be unique.');
}

function assertDiagnostic(diagnostic) {
  assertExactKeys(diagnostic, ['severity', 'code', 'message'], ['source'], 'Content diagnostic');
  if (!['info', 'warning', 'error'].includes(diagnostic.severity)) {
    throw new TypeError('Content diagnostic severity is invalid.');
  }
  if (typeof diagnostic.code !== 'string' || !DIAGNOSTIC_CODE_PATTERN.test(diagnostic.code)) {
    throw new TypeError('Content diagnostic code is invalid.');
  }
  if (typeof diagnostic.message !== 'string' || diagnostic.message.length === 0) {
    throw new TypeError('Content diagnostic message is required.');
  }
  assertCleanString(diagnostic.message, 'Content diagnostic message');
  if (diagnostic.source !== undefined) {
    assertExactKeys(
      diagnostic.source,
      ['sourceId', 'byteOffset', 'byteLength'],
      [],
      'Content diagnostic source',
    );
    if (typeof diagnostic.source.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(diagnostic.source.sourceId)) {
      throw new TypeError('Content diagnostic source ID is invalid.');
    }
    assertNonNegativeInteger(diagnostic.source.byteOffset, 'Content diagnostic byte offset');
    assertNonNegativeInteger(diagnostic.source.byteLength, 'Content diagnostic byte length');
  }
}

function assertCleanData(value, label, assetReferences, rejectBase64 = true) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === 'string') {
    assertCleanString(value, label);
    if (value.includes(':asset:') && ASSET_ID_PATTERN.test(value)) assetReferences.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCleanData(
      item,
      `${label}[${index}]`,
      assetReferences,
      rejectBase64,
    ));
    return;
  }
  assertPlainObject(value, label);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${label} must contain plain JSON values.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (rejectBase64 && /base64$/i.test(key)) {
      throw new TypeError(`${label} contains forbidden field ${key}.`);
    }
    assertCleanData(item, `${label}.${key}`, assetReferences, rejectBase64);
  }
}

function assertFamilyData(data, family, assetReferences) {
  assertPlainObject(data, `Content ${family} data`);
  const entries = Object.entries(data);
  if (entries.length === 0) throw new TypeError(`Content ${family} data must contain a semantic section.`);
  const sections = CONTENT_FAMILY_SCHEMAS[family].sections;
  for (const [section, value] of entries) {
    const expectedType = sections[section];
    if (!expectedType) throw new TypeError(`Content ${family} data contains unsupported section ${section}.`);
    if (expectedType === 'array' && !Array.isArray(value)) {
      throw new TypeError(`Content ${family} section ${section} must be an array.`);
    }
    if (expectedType === 'array' && value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new TypeError(`Content ${family} section ${section} must contain records.`);
    }
    if (expectedType === 'object') assertPlainObject(value, `Content ${family} section ${section}`);
    if (expectedType === 'string' && typeof value !== 'string') {
      throw new TypeError(`Content ${family} section ${section} must be a string.`);
    }
  }
  assertCleanData(data, `Content ${family} data`, assetReferences);
}

export function validateContentAssetRecord(record) {
  assertExactKeys(
    record,
    [
      'schema',
      'id',
      'family',
      'kind',
      'dependencies',
      'provenance',
      'coordinates',
      'timing',
      'artifacts',
      'diagnostics',
      'data',
    ],
    [],
    'Content asset record',
  );
  assertFamily(record.family);
  assertExactKeys(record.schema, ['name', 'version'], [], 'Content family schema');
  if (
    record.schema.name !== CONTENT_FAMILY_SCHEMAS[record.family].name
    || record.schema.version !== CONTENT_FAMILY_SCHEMAS[record.family].version
  ) {
    throw new TypeError(`Content ${record.family} schema is obsolete or invalid.`);
  }
  assertAssetId(record.id, 'Content asset ID');
  assertStableName(record.kind, 'Content asset kind');
  if (!Array.isArray(record.dependencies)) throw new TypeError('Content dependencies must be an array.');
  record.dependencies.forEach(assertDependency);
  const dependencyIds = record.dependencies.map(({ id }) => id);
  if (new Set(dependencyIds).size !== dependencyIds.length || dependencyIds.includes(record.id)) {
    throw new TypeError('Content dependencies must be unique and cannot reference their owner.');
  }
  assertProvenance(record.provenance);
  assertCoordinates(record.coordinates);
  assertTiming(record.timing);
  if (!Array.isArray(record.artifacts)) throw new TypeError('Content artifacts must be an array.');
  record.artifacts.forEach(assertArtifactDescriptor);
  const artifactRoles = record.artifacts.map(({ role }) => role);
  const artifactPaths = record.artifacts.map(({ path }) => path);
  if (
    new Set(artifactRoles).size !== artifactRoles.length
    || new Set(artifactPaths).size !== artifactPaths.length
  ) {
    throw new TypeError('Content artifact roles and paths must be unique per asset.');
  }
  if (!Array.isArray(record.diagnostics)) throw new TypeError('Content diagnostics must be an array.');
  record.diagnostics.forEach(assertDiagnostic);
  const referencedAssets = new Set();
  assertFamilyData(record.data, record.family, referencedAssets);
  for (const reference of referencedAssets) {
    if (reference !== record.id && !dependencyIds.includes(reference)) {
      throw new TypeError(`Content semantic reference is not declared as a dependency: ${reference}.`);
    }
  }
  return record;
}

function assertSourceManifest(source) {
  assertExactKeys(
    source,
    ['discNumber', 'imageSha256', 'catalogSha256', 'sourceIndexSha256'],
    [],
    'Content package source',
  );
  if (source.discNumber !== 1 && source.discNumber !== 2) {
    throw new TypeError('Content package source disc number must be 1 or 2.');
  }
  assertHash(source.imageSha256, 'Content source image hash');
  assertHash(source.catalogSha256, 'Content source catalog hash');
  assertHash(source.sourceIndexSha256, 'Content source index hash');
}

function assertManifestAsset(asset) {
  assertExactKeys(
    asset,
    ['id', 'family', 'schemaVersion', 'path', 'bytes', 'sha256'],
    [],
    'Content manifest asset',
  );
  assertAssetId(asset.id, 'Content manifest asset ID');
  assertFamily(asset.family);
  if (asset.schemaVersion !== CONTENT_FAMILY_SCHEMA_VERSIONS[asset.family]) {
    throw new TypeError(`Content manifest ${asset.family} schema is obsolete or invalid.`);
  }
  assertContentPath(asset.path, 'Content asset record path');
  if (!asset.path.startsWith(`${asset.family}/`) || !asset.path.endsWith('.json')) {
    throw new TypeError(`Content asset record path must be JSON inside ${asset.family}/.`);
  }
  assertNonNegativeInteger(asset.bytes, 'Content asset record byte length');
  assertHash(asset.sha256, 'Content asset record hash');
}

function assertManifestReport(report) {
  assertExactKeys(
    report,
    ['role', 'path', 'mediaType', 'bytes', 'sha256'],
    [],
    'Content package report',
  );
  assertStableName(report.role, 'Content package report role');
  assertContentPath(report.path, 'Content package report path');
  if (!report.path.startsWith('reports/') || !report.path.endsWith('.json')) {
    throw new TypeError('Content package reports must be JSON inside reports/.');
  }
  if (report.mediaType !== 'application/json') {
    throw new TypeError('Content package report media type must be application/json.');
  }
  assertNonNegativeInteger(report.bytes, 'Content package report byte length');
  assertHash(report.sha256, 'Content package report hash');
}

export function validateContentManifest(manifest) {
  assertExactKeys(
    manifest,
    ['schema', 'sources', 'assets', 'reports', 'packageSha256'],
    [],
    'Content package manifest',
  );
  assertExactKeys(manifest.schema, ['name', 'version'], [], 'Content package schema');
  if (
    manifest.schema.name !== 'xenogears-content-package'
    || manifest.schema.version !== CONTENT_PACKAGE_SCHEMA_VERSION
  ) {
    throw new TypeError('Content package schema is obsolete or invalid.');
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== 2) {
    throw new TypeError('Content package must identify both disc sources.');
  }
  manifest.sources.forEach(assertSourceManifest);
  if (new Set(manifest.sources.map(({ discNumber }) => discNumber)).size !== 2) {
    throw new TypeError('Content package disc sources must be unique.');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new TypeError('Content package must contain at least one semantic asset.');
  }
  manifest.assets.forEach(assertManifestAsset);
  if (!Array.isArray(manifest.reports)) throw new TypeError('Content package reports must be an array.');
  manifest.reports.forEach(assertManifestReport);
  assertHash(manifest.packageSha256, 'Content package hash');

  const assetIds = manifest.assets.map(({ id }) => id);
  const reportRoles = manifest.reports.map(({ role }) => role);
  const paths = [
    ...manifest.assets.map(({ path }) => path),
    ...manifest.reports.map(({ path }) => path),
  ];
  if (new Set(assetIds).size !== assetIds.length) {
    throw new TypeError('Content manifest asset IDs must be unique.');
  }
  if (new Set(reportRoles).size !== reportRoles.length) {
    throw new TypeError('Content manifest report roles must be unique.');
  }
  if (new Set(paths).size !== paths.length || paths.includes('manifest.json')) {
    throw new TypeError('Content manifest paths must be unique.');
  }
  return manifest;
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

export function canonicalJson(value, spacing = 0) {
  return JSON.stringify(sortJsonValue(value), null, spacing);
}

export function validateCleanContentValue(value, label = 'Content data') {
  assertCleanData(value, label, new Set(), false);
  return value;
}
