export const SCENE_MODEL_CACHE_VERSION = 7;
export const SCENE_MODEL_CONVERSION_REVISION = 1;
export const SCENE_MODEL_FIXED_POINT_ONE = 4096;

export const XENOGEARS_METERS_PER_SHARL = 0.97;
export const XENOGEARS_METERS_PER_SOOL = 0.333;

export const WELTALL_SCALE_REFERENCE = Object.freeze({
  modelNumber: 1,
  canonicalHeightSharls: 16.3,
  canonicalHeightMeters: 15.811,
  rawHeight: 6080,
  embeddedScale: 320,
  engineHeight: 475,
});

export const SCENE_MODEL_METERS_PER_ENGINE_UNIT =
  WELTALL_SCALE_REFERENCE.canonicalHeightMeters / WELTALL_SCALE_REFERENCE.engineHeight;

const DIMENSION_NAMES = ['height', 'width', 'depth'];

function dimensionsObject(values, multiplier = 1) {
  return Object.fromEntries(DIMENSION_NAMES.map((name, index) => [name, values[index] * multiplier]));
}

function scaleDimensions(dimensions, multiplier) {
  return Object.fromEntries(DIMENSION_NAMES.map((name) => [name, dimensions[name] * multiplier]));
}

export function createSceneModelMeasurements(modelConfig) {
  const embeddedScaleFactor = modelConfig.embeddedScale / SCENE_MODEL_FIXED_POINT_ONE;
  const raw = dimensionsObject(modelConfig.rawDimensions);
  const engineUnits = scaleDimensions(raw, embeddedScaleFactor);
  const meters = scaleDimensions(engineUnits, SCENE_MODEL_METERS_PER_ENGINE_UNIT);

  return {
    conversionRevision: SCENE_MODEL_CONVERSION_REVISION,
    dimensionOrder: [...DIMENSION_NAMES],
    dimensions: {
      raw,
      engineUnits,
      meters,
      sools: scaleDimensions(meters, 1 / XENOGEARS_METERS_PER_SOOL),
      sharls: scaleDimensions(meters, 1 / XENOGEARS_METERS_PER_SHARL),
      unrealCentimeters: scaleDimensions(meters, 100),
    },
    scale: {
      embedded: modelConfig.embeddedScale,
      fixedDivisor: SCENE_MODEL_FIXED_POINT_ONE,
      embeddedFactor: embeddedScaleFactor,
      metersPerEngineUnit: SCENE_MODEL_METERS_PER_ENGINE_UNIT,
      metersPerRawUnit: embeddedScaleFactor * SCENE_MODEL_METERS_PER_ENGINE_UNIT,
      unrealCentimetersPerEngineUnit: SCENE_MODEL_METERS_PER_ENGINE_UNIT * 100,
    },
    calibration: {
      basis: 'Weltall nominal height',
      ...WELTALL_SCALE_REFERENCE,
    },
  };
}
