import crypto from 'node:crypto';

export const DISC_EQUIVALENCE_SCHEMA_VERSION = 1;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.files)) {
    throw new TypeError('A valid raw Disc catalog is required.');
  }
  if (catalog.source?.discNumber !== 1 && catalog.source?.discNumber !== 2) {
    throw new TypeError('Catalog disc number must be 1 or 2.');
  }
}

function payloadOccurrences(catalog) {
  const occurrences = new Map();
  for (const file of catalog.files) {
    if (file.recordType !== 'file') continue;
    const key = `${file.logicalBytes}:${file.payloadSha256}`;
    if (!occurrences.has(key)) occurrences.set(key, []);
    occurrences.get(key).push(file.id);
  }
  return occurrences;
}

export function buildCrossDiscEquivalence(firstCatalog, secondCatalog) {
  validateCatalog(firstCatalog);
  validateCatalog(secondCatalog);
  if (firstCatalog.source.discNumber === secondCatalog.source.discNumber) {
    throw new TypeError('Cross-disc equivalence requires one catalog for each disc.');
  }

  const catalogs = new Map([
    [firstCatalog.source.discNumber, firstCatalog],
    [secondCatalog.source.discNumber, secondCatalog],
  ]);
  const discOne = catalogs.get(1);
  const discTwo = catalogs.get(2);
  const discOneOccurrences = payloadOccurrences(discOne);
  const discTwoOccurrences = payloadOccurrences(discTwo);
  const groups = [];

  for (const [key, disc1OccurrenceIds] of discOneOccurrences) {
    const disc2OccurrenceIds = discTwoOccurrences.get(key);
    if (!disc2OccurrenceIds) continue;
    const separator = key.indexOf(':');
    groups.push({
      logicalBytes: Number.parseInt(key.slice(0, separator), 10),
      payloadSha256: key.slice(separator + 1),
      disc1OccurrenceIds: [...disc1OccurrenceIds].sort(),
      disc2OccurrenceIds: [...disc2OccurrenceIds].sort(),
    });
  }
  groups.sort((left, right) => (
    left.payloadSha256.localeCompare(right.payloadSha256)
    || left.logicalBytes - right.logicalBytes
  ));

  const body = {
    schemaVersion: DISC_EQUIVALENCE_SCHEMA_VERSION,
    source: {
      disc1CatalogSha256: discOne.catalogSha256,
      disc2CatalogSha256: discTwo.catalogSha256,
    },
    summary: {
      payloadGroupCount: groups.length,
      uniqueLogicalBytes: groups.reduce((total, group) => total + group.logicalBytes, 0),
      disc1OccurrenceCount: groups.reduce((total, group) => total + group.disc1OccurrenceIds.length, 0),
      disc2OccurrenceCount: groups.reduce((total, group) => total + group.disc2OccurrenceIds.length, 0),
      disc1LogicalOccurrenceBytes: groups.reduce(
        (total, group) => total + (group.logicalBytes * group.disc1OccurrenceIds.length),
        0,
      ),
      disc2LogicalOccurrenceBytes: groups.reduce(
        (total, group) => total + (group.logicalBytes * group.disc2OccurrenceIds.length),
        0,
      ),
    },
    groups,
  };
  return {
    ...body,
    equivalenceSha256: sha256(JSON.stringify(body)),
  };
}
