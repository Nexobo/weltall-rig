import crypto from 'node:crypto';

import { validateCleanContentValue } from '../../../shared/content/content-schema.js';
import { BinaryReader, XenoFormatError } from '../xeno/binary-reader.js';
import { assertSourceContext } from './source-input.js';

export const AUDIO_RECORD_SCHEMA_VERSION = 2;
export const AUDIO_DECODER = Object.freeze({ id: 'native-audio', revision: 4 });

const SPU_FRAME_BYTES = 16;
const SPU_FRAME_SAMPLES = 28;
const SPU_REFERENCE_SAMPLE_RATE = 44_100;
const SOUND_FILE_VERSION = 0x0101;
const DELTA_TIME_TABLE = Object.freeze([
  0, 192, 144, 96, 72, 64, 48, 36, 32, 24, 18, 16, 12, 9, 8, 6, 4, 3, 2,
]);
const ADPCM_FILTERS = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([60, 0]),
  Object.freeze([115, -52]),
  Object.freeze([98, -55]),
  Object.freeze([122, -60]),
]);

// Total encoded bytes, including the opcode. This is the retail table recovered
// by the local Noah and xenogears-decomp references.
const OPCODE_BYTES = Object.freeze([
  2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 4, 1,
  1, 1, 1, 1, 2, 1, 1, 3, 2, 1, 1, 1, 4, 4, 4, 1,
  2, 2, 3, 1, 2, 2, 2, 3, 1, 2, 2, 1, 2, 2, 1, 1,
  1, 1, 1, 1, 2, 2, 1, 1, 4, 1, 1, 1, 4, 1, 1, 1,
  1, 4, 2, 2, 2, 2, 2, 3, 2, 2, 2, 1, 1, 1, 1, 1,
  2, 2, 2, 3, 3, 1, 2, 2, 4, 4, 1, 1, 1, 1, 1, 1,
  2, 2, 3, 2, 4, 4, 1, 1, 2, 2, 3, 2, 4, 4, 1, 1,
  4, 4, 3, 1, 1, 2, 2, 2, 4, 3, 1, 1, 3, 2, 2, 1,
]);

const RESERVED_OPCODES = Object.freeze(new Set([
  0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8b, 0x8c,
  0x92, 0x93, 0x9b, 0x9f, 0xa3, 0xa8, 0xab, 0xb9, 0xbf,
  0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xdd, 0xde, 0xdf,
  0xf3, 0xf4, 0xfa, 0xfb,
]));

const COMPLETE_OPCODE_TYPES = Object.freeze(new Map([
  [0x80, 'rest'],
  [0x81, 'tie'],
  [0x8a, 'driver-no-op'],
  [0x8e, 'driver-no-op'],
  [0x8f, 'driver-no-op'],
  [0x90, 'repeat-or-end'],
  [0x91, 'set-repeat-point'],
  [0x94, 'set-octave'],
  [0x95, 'raise-octave'],
  [0x96, 'lower-octave'],
  [0x97, 'configure-meter'],
  [0x98, 'counted-loop-start'],
  [0x99, 'counted-loop-end'],
  [0x9a, 'counted-loop-break'],
  [0x9c, 'play-seds-effect'],
  [0x9d, 'stop-seds-effect'],
  [0x9e, 'external-sequence-transfer'],
  [0xa0, 'set-tempo'],
  [0xa1, 'adjust-tempo'],
  [0xa2, 'tempo-slide'],
  [0xa6, 'set-master-volume'],
  [0xa7, 'master-volume-slide'],
  [0xa9, 'set-gate-mode'],
  [0xaa, 'reassign-spu-voice'],
  [0xac, 'load-preset'],
  [0xad, 'adjust-duration'],
  [0xae, 'percussion-on'],
  [0xaf, 'percussion-off'],
  [0xb0, 'legato-on'],
  [0xb1, 'legato-off'],
  [0xb2, 'frequency-modulation-on'],
  [0xb3, 'frequency-modulation-off'],
  [0xb4, 'set-noise-clock'],
  [0xb5, 'adjust-noise-clock'],
  [0xb6, 'noise-on'],
  [0xb7, 'noise-off'],
  [0xb8, 'set-reverb-parameters'],
  [0xba, 'reverb-send-on'],
  [0xbb, 'reverb-send-off'],
  [0xbc, 'driver-no-op'],
  [0xbd, 'driver-no-op'],
  [0xbe, 'driver-no-op'],
  [0xc0, 'reload-preset'],
  [0xc1, 'set-adsr-modes'],
  [0xc2, 'set-attack-rate'],
  [0xc3, 'set-decay-rate'],
  [0xc4, 'set-sustain-rate'],
  [0xc5, 'set-release-rate'],
  [0xc6, 'set-sustain-level'],
  [0xc7, 'set-decay-rate-and-sustain-level'],
  [0xc8, 'set-attack-mode'],
  [0xc9, 'set-sustain-mode'],
  [0xca, 'set-release-mode'],
  [0xd0, 'set-pitch-offset'],
  [0xd1, 'adjust-pitch-offset'],
  [0xd2, 'adjust-fine-pitch-offset'],
  [0xd3, 'adjust-q8-pitch-offset'],
  [0xd4, 'pitch-slide'],
  [0xd5, 'toggle-continuous-pitch-slide'],
  [0xd6, 'set-portamento-duration'],
  [0xd7, 'set-pitch-modulator-ramp'],
  [0xd8, 'configure-standard-pitch-modulator'],
  [0xd9, 'configure-general-pitch-modulator'],
  [0xda, 'pitch-modulator-on'],
  [0xdb, 'pitch-modulator-off'],
  [0xdc, 'cancel-pitch-slide'],
  [0xe0, 'set-volume'],
  [0xe1, 'adjust-volume'],
  [0xe2, 'volume-slide'],
  [0xe3, 'set-volume-modulator-ramp'],
  [0xe4, 'configure-standard-volume-modulator'],
  [0xe5, 'configure-general-volume-modulator'],
  [0xe6, 'volume-modulator-on'],
  [0xe7, 'volume-modulator-off'],
  [0xe8, 'set-pan'],
  [0xe9, 'adjust-pan'],
  [0xea, 'pan-slide'],
  [0xeb, 'set-pan-modulator-ramp'],
  [0xec, 'configure-standard-pan-modulator'],
  [0xed, 'configure-general-pan-modulator'],
  [0xee, 'pan-modulator-on'],
  [0xef, 'pan-modulator-off'],
  [0xf0, 'configure-modulator'],
  [0xf1, 'set-modulator-period-and-amplitude'],
  [0xf2, 'set-modulator-delay-and-ramp'],
  [0xf5, 'driver-no-op'],
  [0xf6, 'enable-modulator'],
  [0xf7, 'disable-modulator'],
  [0xf8, 'per-note-volume-sweep'],
  [0xf9, 'update-meter'],
  [0xfc, 'select-bank-and-preset'],
  [0xfd, 'set-tempo-scale'],
  [0xfe, 'select-bank'],
  [0xff, 'retire-ended-voice'],
]));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceBytes(value, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes.`);
  return value;
}

function sourceRecord(context) {
  return {
    id: context.sourceId,
    discNumber: context.discNumber,
    bytes: context.logicalBytes,
    sha256: context.sha256,
    ranges: [{ offset: 0, length: context.logicalBytes }],
  };
}

function ascii(reader, offset, length) {
  return Buffer.from(reader.slice(offset, length)).toString('ascii');
}

function requireMagic(reader, expected, label) {
  if (ascii(reader, 0, 4) !== expected) {
    throw new XenoFormatError(`${label} signature is invalid.`, 'INVALID_AUDIO_MAGIC', {
      expected,
    });
  }
}

function additiveWordChecksum(reader, length) {
  reader.check(0, length);
  let sum = 0;
  for (let offset = 0; offset < length; offset += 4) {
    let word = 0;
    for (let byte = 0; byte < 4 && offset + byte < length; byte += 1) {
      word = (word + reader.u8(offset + byte) * (2 ** (byte * 8))) >>> 0;
    }
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function requireChecksum(reader, length, label) {
  if (additiveWordChecksum(reader, length) !== 0) {
    throw new XenoFormatError(`${label} checksum is invalid.`, 'INVALID_AUDIO_CHECKSUM', {
      checksumRangeBytes: length,
    });
  }
}

function requireVersion(reader, label) {
  const version = reader.u16(0x0c);
  if (version !== SOUND_FILE_VERSION || reader.u16(0x0e) !== 0) {
    throw new XenoFormatError(`${label} uses an unsupported format version.`, 'UNSUPPORTED_AUDIO_VERSION', {
      version,
      headerValue0e: reader.u16(0x0e),
      expectedVersion: SOUND_FILE_VERSION,
    });
  }
  return version;
}

function requireZero(value, label, offset) {
  if (value !== 0) {
    throw new XenoFormatError(`${label} must be zero.`, 'INVALID_AUDIO_RESERVED_VALUE', {
      offset,
      value,
    });
  }
}

function clamp16(value) {
  return Math.max(-0x8000, Math.min(0x7fff, value));
}

function decodeAdpcmPcm(reader, dataOffset, encodedBytes, history = [0, 0]) {
  const pcm = Buffer.alloc((encodedBytes / SPU_FRAME_BYTES) * SPU_FRAME_SAMPLES * 2);
  let [previous1, previous2] = history;
  let outputOffset = 0;
  for (let frameOffset = 0; frameOffset < encodedBytes; frameOffset += SPU_FRAME_BYTES) {
    const header = reader.u8(dataOffset + frameOffset);
    const shift = header & 0x0f;
    const filter = header >>> 4;
    const coefficients = ADPCM_FILTERS[filter];
    for (let index = 0; index < 28; index += 1) {
      const packed = reader.u8(dataOffset + frameOffset + 2 + (index >>> 1));
      const nibble = index & 1 ? packed >>> 4 : packed & 0x0f;
      const signed = nibble >= 8 ? nibble - 16 : nibble;
      const predicted = ((previous1 * coefficients[0]) + (previous2 * coefficients[1]) + 32) >> 6;
      const sample = clamp16((signed << 12 >> shift) + predicted);
      pcm.writeInt16LE(sample, outputOffset);
      outputOffset += 2;
      previous2 = previous1;
      previous1 = sample;
    }
  }
  return {
    bytes: Uint8Array.from(pcm),
    frames: pcm.byteLength / 2,
    history: [previous1, previous2],
    sha256: sha256(pcm),
  };
}

// Normalize a source sample into PCM with an exact initial section and repeat.
// A loop may only be repeated after its predictor history returns to the same
// state. The original first-pass decoder record remains source evidence.
export function prepareSpuSamplePlayback(value, sample) {
  const bytes = sourceBytes(value, 'SPU sample playback'), reader = new BinaryReader(bytes, 'SPU sample playback');
  const { offset, length } = sample?.encodedRange ?? {};
  if (!sample?.present || !Number.isSafeInteger(offset) || offset < 0 || offset % 16 !== 0
    || !Number.isSafeInteger(length) || length < 16 || length % 16 !== 0) throw new Error('Invalid sample playback range.');
  reader.check(offset, length);
  if (sha256(reader.slice(offset, length)) !== sample.encodedSha256) throw new Error('Sample playback source hash differs.');
  const ending = findSampleEnd(reader, offset, length, 0, sample.index);
  if (ending.endByte !== length || ending.endFlags !== sample.adpcmEndFlags) throw new Error('Sample playback terminator differs.');
  const first = decodeAdpcmPcm(reader, offset, length);
  if (!sample.repeat?.enabled) {
    if (ending.endFlags !== 1) throw new Error('Finite sample playback requires a non-repeating terminator.');
    return { pcm: first.bytes, loopStartFrame: null, loopEndFrame: null, sha256: first.sha256 };
  }
  const repeatOffset = sample.repeat.offsetBytes;
  if (!(ending.endFlags & 2) || !Number.isSafeInteger(repeatOffset) || repeatOffset < 0
    || repeatOffset >= length || repeatOffset % 16 !== 0) throw new Error('Invalid sample playback repeat address.');
  // Some short original loops need several passes before their predictor state
  // repeats. Keep that exact intro; never loop the first pass or reset history.
  const parts = [first.bytes], seen = new Map([[first.history.join(','), first.frames]]);
  let current = first, frames = first.frames;
  for (let pass = 0; pass < 1024 && frames < 1048576; pass++) {
    current = decodeAdpcmPcm(reader, offset + repeatOffset, length - repeatOffset, current.history);
    parts.push(current.bytes); frames += current.frames;
    const key = current.history.join(','), loopStartFrame = seen.get(key);
    if (loopStartFrame !== undefined) {
      const pcm = new Uint8Array(frames * 2);
      let position = 0;
      for (const part of parts) { pcm.set(part, position); position += part.length; }
      return { pcm, loopStartFrame, loopEndFrame: frames, sha256: sha256(pcm) };
    }
    seen.set(key, frames);
  }
  throw new Error('Sample repeat does not restore its predictor history within the preparation bound.');
}

// A held repeat-register change enters another sample without resetting its
// predictor. Prepare that short stream separately from either ordinary sample.
export function prepareSpuSampleTransition(fromBytes, from, targetBytes, target, offsetBytes) {
  const old = prepareSpuSamplePlayback(fromBytes, from);
  prepareSpuSamplePlayback(targetBytes, target); // Authenticate the complete target.
  if (!from.repeat?.enabled || !target.repeat?.enabled || !Number.isSafeInteger(offsetBytes)
    || offsetBytes < 0 || offsetBytes >= target.encodedRange.length || offsetBytes % 16
    || from.pcm.frames !== from.encodedRange.length / 16 * 28
    || from.repeat.pcmFrame !== from.repeat.offsetBytes / 16 * 28) {
    throw new Error('Invalid held sample transition range.');
  }
  const tail = frame => [old.pcm[frame * 2 - 2] | old.pcm[frame * 2 - 1] << 8,
    old.pcm[frame * 2 - 4] | old.pcm[frame * 2 - 3] << 8].map(value => value << 16 >> 16);
  const history = tail(from.pcm.frames);
  // One route is valid at every old loop end only when each pass has the same
  // terminal history. A settling old sample needs further preparation.
  const repeatFrames = from.pcm.frames - from.repeat.pcmFrame;
  for (let frame = from.pcm.frames; frame <= old.loopEndFrame; frame += repeatFrames) {
    if (tail(frame).some((value, index) => value !== history[index])) {
      throw new Error('Held sample source has a changing terminal predictor.');
    }
  }
  const reader = new BinaryReader(targetBytes, 'Held sample transition');
  const offset = target.encodedRange.offset + offsetBytes, length = target.encodedRange.length - offsetBytes;
  const parts = [], seen = new Map([[history.join(','), 0]]);
  let current = { history }, frames = 0;
  for (let pass = 0; pass < 1024 && frames < 1048576; pass++) {
    current = decodeAdpcmPcm(reader, offset, length, current.history);
    parts.push(current.bytes); frames += current.frames;
    const key = current.history.join(','), loopStartFrame = seen.get(key);
    if (loopStartFrame !== undefined) {
      const pcm = new Uint8Array(frames * 2); let position = 0;
      for (const part of parts) { pcm.set(part, position); position += part.length; }
      return { pcm, loopStartFrame, loopEndFrame: frames, sha256: sha256(pcm) };
    }
    seen.set(key, frames);
  }
  throw new Error('Held sample target does not restore its predictor within the preparation bound.');
}

function findSampleEnd(reader, dataOffset, adpcmBytes, startByte, sampleIndex) {
  for (let offset = startByte; offset < adpcmBytes; offset += SPU_FRAME_BYTES) {
    const header = reader.u8(dataOffset + offset);
    const flags = reader.u8(dataOffset + offset + 1);
    const shift = header & 0x0f;
    const filter = header >>> 4;
    if (shift > 12 || filter >= ADPCM_FILTERS.length || (flags & ~0x07) !== 0) {
      throw new XenoFormatError('WDS contains an invalid SPU ADPCM frame.', 'INVALID_SPU_ADPCM_FRAME', {
        sampleIndex,
        offset,
        shift,
        filter,
        flags,
      });
    }
    if ((flags & 0x01) !== 0) return { endByte: offset + SPU_FRAME_BYTES, endFlags: flags };
  }
  throw new XenoFormatError('WDS sample has no terminating ADPCM frame.', 'UNTERMINATED_SPU_ADPCM_SAMPLE', {
    sampleIndex,
    startByte,
  });
}

function rangesFromCoverage(coverage, bytes, startOffset = 0) {
  const paddingRanges = [];
  const unresolvedRanges = [];
  let offset = 0;
  while (offset < coverage.length) {
    if (coverage[offset] !== 0) {
      offset += 1;
      continue;
    }
    const start = offset;
    let allZero = true;
    while (offset < coverage.length && coverage[offset] === 0) {
      if (bytes[startOffset + offset] !== 0) allZero = false;
      offset += 1;
    }
    const range = { offset: startOffset + start, length: offset - start };
    if (allZero) paddingRanges.push(range);
    else unresolvedRanges.push(range);
  }
  return { paddingRanges, unresolvedRanges };
}

function mark(coverage, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset + length > coverage.length) {
    throw new XenoFormatError(`${label} is outside the declared audio data.`, 'INVALID_AUDIO_RANGE', {
      offset,
      length,
      declaredBytes: coverage.length,
    });
  }
  coverage.fill(1, offset, offset + length);
}

export function decodeWdsSampleBank(value, context) {
  const bytes = sourceBytes(value, 'WDS sample bank');
  assertSourceContext(bytes, context);
  const inputSha256 = sha256(bytes);
  const reader = new BinaryReader(bytes, 'WDS sample bank');
  reader.check(0, 0x30);
  requireMagic(reader, 'wds ', 'WDS sample bank');
  const version = requireVersion(reader, 'WDS sample bank');
  const checksumRangeBytes = reader.u32(0x08);
  const headerBytes = reader.u32(0x10);
  const adpcmBytes = reader.u32(0x14);
  const adpcmOffset = reader.u32(0x18);
  const sampleCount = reader.u16(0x1c) + 1;
  const allocationClass = reader.u16(0x1e);
  const bankId = reader.u16(0x20);
  requireZero(reader.u16(0x22), 'WDS reserved header value', 0x22);
  requireZero(reader.u32(0x24), 'WDS reserved header value', 0x24);
  requireZero(reader.u32(0x2c), 'WDS linked-list placeholder', 0x2c);
  if (
    checksumRangeBytes !== headerBytes
    || headerBytes !== adpcmOffset
    || headerBytes !== 0x30 + sampleCount * 0x10
    || adpcmOffset + adpcmBytes !== bytes.byteLength
    || adpcmOffset % SPU_FRAME_BYTES !== 0
    || adpcmBytes % SPU_FRAME_BYTES !== 0
  ) {
    throw new XenoFormatError('WDS header and ADPCM ranges are inconsistent.', 'INVALID_WDS_LAYOUT', {
      checksumRangeBytes,
      headerBytes,
      adpcmBytes,
      adpcmOffset,
      sampleCount,
      sourceBytes: bytes.byteLength,
    });
  }
  requireZero(allocationClass, 'WDS allocation class', 0x1e);
  requireChecksum(reader, checksumRangeBytes, 'WDS sample bank');

  const dataCoverage = new Uint8Array(adpcmBytes);
  const samples = [];
  const instruments = [];
  const derivatives = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const descriptorOffset = 0x30 + index * 0x10;
    const descriptor = reader.slice(descriptorOffset, 0x10);
    if (descriptor.every((byte) => byte === 0)) {
      samples.push({ id: `${context.sourceId}:sample-${index}`, index, present: false });
      instruments.push({ id: `${context.sourceId}:instrument-${index}`, index, present: false });
      continue;
    }
    const startByte = reader.u32(descriptorOffset) * 8;
    const repeatOffsetBytes = reader.u16(descriptorOffset + 4) * 8;
    const pitchOffset256ths = reader.i16(descriptorOffset + 6);
    const envelopeBits = reader.u32(descriptorOffset + 8);
    const envelopeModes = reader.u16(descriptorOffset + 0x0c);
    const retailIgnoredLevel = reader.u16(descriptorOffset + 0x0e);
    if (
      startByte % SPU_FRAME_BYTES !== 0
      || startByte >= adpcmBytes
      || repeatOffsetBytes % SPU_FRAME_BYTES !== 0
      || retailIgnoredLevel !== 0x7f
    ) {
      throw new XenoFormatError('WDS sample descriptor is invalid.', 'INVALID_WDS_SAMPLE_DESCRIPTOR', {
        index,
        startByte,
        repeatOffsetBytes,
        retailIgnoredLevel,
      });
    }
    const { endByte, endFlags } = findSampleEnd(reader, adpcmOffset, adpcmBytes, startByte, index);
    const encodedBytes = endByte - startByte;
    if (repeatOffsetBytes > encodedBytes) {
      throw new XenoFormatError('WDS repeat address is outside its sample.', 'INVALID_WDS_REPEAT_ADDRESS', {
        index,
        repeatOffsetBytes,
        encodedBytes,
      });
    }
    dataCoverage.fill(1, startByte, endByte);
    const pcm = decodeAdpcmPcm(reader, adpcmOffset + startByte, encodedBytes);
    const sampleId = `${context.sourceId}:sample-${index}`;
    const derivativeId = `${sampleId}:pcm`;
    samples.push({
      id: sampleId,
      index,
      present: true,
      encodedRange: { offset: adpcmOffset + startByte, length: encodedBytes },
      encodedSha256: sha256(reader.slice(adpcmOffset + startByte, encodedBytes)),
      repeat: {
        enabled: (endFlags & 0x02) !== 0 && repeatOffsetBytes < encodedBytes,
        offsetBytes: repeatOffsetBytes,
        pcmFrame: repeatOffsetBytes < encodedBytes
          ? (repeatOffsetBytes / SPU_FRAME_BYTES) * SPU_FRAME_SAMPLES
          : null,
      },
      adpcmEndFlags: endFlags,
      pcm: {
        derivativeId,
        encoding: 'pcm-s16le',
        channels: 1,
        referenceSampleRateHz: SPU_REFERENCE_SAMPLE_RATE,
        frames: pcm.frames,
        bytes: pcm.bytes.byteLength,
        sha256: pcm.sha256,
      },
    });
    derivatives.push({
      id: derivativeId,
      role: 'sample-pcm',
      encoding: 'pcm-s16le',
      channels: 1,
      sampleRateHz: SPU_REFERENCE_SAMPLE_RATE,
      frames: pcm.frames,
      bytes: pcm.bytes.byteLength,
      sha256: pcm.sha256,
      pcm: pcm.bytes,
    });
    instruments.push({
      id: `${context.sourceId}:instrument-${index}`,
      index,
      present: true,
      sampleId,
      pitchOffset256ths,
      envelope: {
        attackMode: envelopeModes & 0x07,
        sustainMode: (envelopeModes >>> 4) & 0x07,
        releaseMode: (envelopeModes >>> 8) & 0x07,
        attackRate: envelopeBits & 0x7f,
        decayShift: (envelopeBits >>> 8) & 0x0f,
        sustainLevel: (envelopeBits >>> 12) & 0x0f,
        sustainRate: (envelopeBits >>> 16) & 0x7f,
        releaseShift: (envelopeBits >>> 24) & 0x1f,
      },
      retailIgnoredLevel,
    });
  }

  let terminalPaddingFrameCount = 0;
  for (let offset = 0; offset < adpcmBytes; offset += SPU_FRAME_BYTES) {
    if (dataCoverage[offset] !== 0) continue;
    const frame = reader.slice(adpcmOffset + offset, SPU_FRAME_BYTES);
    const hex = Buffer.from(frame).toString('hex');
    if (
      hex !== '00077777777777777777777777777777'
      && hex !== '00070707070707070707070707070707'
    ) {
      throw new XenoFormatError('WDS contains unowned ADPCM data.', 'UNRESOLVED_WDS_ADPCM_RANGE', {
        offset: adpcmOffset + offset,
        length: SPU_FRAME_BYTES,
      });
    }
    dataCoverage.fill(1, offset, offset + SPU_FRAME_BYTES);
    terminalPaddingFrameCount += 1;
  }

  if (sha256(bytes) !== inputSha256) throw new Error('Audio decoder mutated its input.');
  const semantic = validateCleanContentValue({
    schema: { name: 'xenogears-audio-sample-bank', version: AUDIO_RECORD_SCHEMA_VERSION },
    id: `${context.sourceId}:sample-bank`,
    kind: 'sample-bank',
    complete: true,
    decoder: { ...AUDIO_DECODER },
    source: sourceRecord(context),
    format: {
      magic: 'wds ',
      version,
      checksum: reader.u32(0x04),
      checksumRangeBytes,
      headerBytes,
      adpcmOffset,
      adpcmBytes,
    },
    bankId,
    requestedSpuAddress: reader.u32(0x28),
    terminalPaddingFrameCount,
    samples,
    instruments,
    diagnostics: [],
  }, 'WDS semantic decode');
  return { semantic, derivatives };
}

function signedByte(value) {
  return value < 0x80 ? value : value - 0x100;
}

function signedBigEndianWord(high, low) {
  const value = (high << 8) | low;
  return value < 0x8000 ? value : value - 0x10000;
}

function standardModulator(base, operands, slot, target, waveform) {
  return {
    ...base,
    slot,
    target,
    waveform,
    periodValue: operands[0],
    depth: signedByte(operands[1]),
    delay: operands[2],
    retriggerOnNote: true,
  };
}

function generalModulator(base, operands, slot, target) {
  return {
    ...base,
    slot,
    target,
    periodValue: operands[0],
    depth: signedByte(operands[1]),
    waveform: operands[2] & 0x0f,
    retriggerOnNote: (operands[2] & 0x10) === 0,
  };
}

function modulatorSlot(value, opcode) {
  if (value >= 4) {
    throw new XenoFormatError('Audio command selects an invalid modulator slot.', 'INVALID_AUDIO_MODULATOR_SLOT', {
      opcode,
      slot: value,
    });
  }
  return value;
}

function modulatorTarget(value, opcode) {
  const target = ['pitch', 'volume', 'pan'][value];
  if (!target) {
    throw new XenoFormatError('Audio command selects an invalid modulator target.', 'INVALID_AUDIO_MODULATOR_TARGET', {
      opcode,
      target: value,
    });
  }
  return target;
}

function semanticCommand(opcode, operands) {
  const base = { type: COMPLETE_OPCODE_TYPES.get(opcode) };
  switch (opcode) {
    case 0x80:
    case 0x81: return { ...base, ticks: operands[0] };
    case 0x8e:
    case 0xbc:
    case 0xf5: return { ...base, retailIgnoredValues: operands };
    case 0x94: return { ...base, octave: operands[0] };
    case 0x97: return { ...base, beatsPerBar: operands[0], beatUnit: operands[1] };
    case 0x98: return { ...base, repeatCount: operands[0] || 256 };
    case 0x9c:
    case 0x9d: return {
      ...base,
      effectId: operands[0] | (operands[1] << 8),
      retailIgnoredValue: operands[2],
    };
    case 0x9e: return {
      ...base,
      effectIndex: operands[0] | (operands[1] << 8),
      channelIndex: operands[2],
      runtimeContext: 'audio-element-target-seds-id',
    };
    case 0xa0: return { ...base, tempo: operands[0] };
    case 0xa1: return { ...base, adjustment: signedByte(operands[0]) };
    case 0xa2: return { ...base, duration: operands[0], targetTempo: operands[1] };
    case 0xa6: return { ...base, volume: operands[0] };
    case 0xa7: return { ...base, duration: operands[0], targetVolume: operands[1] };
    case 0xa9: return { ...base, gateMode: operands[0] };
    case 0xaa: return {
      ...base,
      voiceIndex: operands[0],
      runtimeContext: 'physical-spu-voice-ownership',
    };
    case 0xac: return { ...base, presetIndex: operands[0] };
    case 0xad: return { ...base, adjustment: signedByte(operands[0]) };
    case 0xb4: return { ...base, clock: operands[0] };
    case 0xb5: return { ...base, adjustment: signedByte(operands[0]) };
    case 0xb8: return {
      ...base,
      depth: signedByte(operands[0]),
      delay: signedByte(operands[1]),
      feedback: signedByte(operands[2]),
      runtimeContext: 'global-reverb-state',
    };
    case 0xba:
    case 0xbb: return { ...base, runtimeContext: 'global-reverb-state' };
    case 0xc1: return {
      ...base,
      attackMode: operands[0] & 0x07,
      sustainMode: operands[1] & 0x07,
      releaseMode: operands[2] & 0x07,
    };
    case 0xc2: return { ...base, rate: operands[0] & 0x7f };
    case 0xc3: return { ...base, rate: operands[0] & 0x0f };
    case 0xc4: return { ...base, rate: operands[0] & 0x7f };
    case 0xc5: return { ...base, rate: operands[0] & 0x1f };
    case 0xc6: return { ...base, level: operands[0] & 0x0f };
    case 0xc7: return {
      ...base,
      decayRate: operands[0] & 0x0f,
      sustainLevel: operands[1] & 0x0f,
    };
    case 0xc8:
    case 0xc9:
    case 0xca: return { ...base, mode: operands[0] & 0x07 };
    case 0xd0: return { ...base, offsetEighthSemitones: signedByte(operands[0]) };
    case 0xd1: return { ...base, deltaEighthSemitones: signedByte(operands[0]) };
    case 0xd2: return { ...base, deltaThirtySecondSemitones: signedByte(operands[0]) };
    case 0xd3: return { ...base, deltaQ8: signedBigEndianWord(operands[0], operands[1]) };
    case 0xd4: return { ...base, duration: operands[0], deltaSemitones: signedByte(operands[1]) };
    case 0xd6: return { ...base, duration: operands[0] };
    case 0xd7: return { ...base, rampValue: operands[0] };
    case 0xd8: return standardModulator(base, operands, 0, 'pitch', 3);
    case 0xd9: return generalModulator(base, operands, 0, 'pitch');
    case 0xe0: return { ...base, volume: operands[0] };
    case 0xe1: return { ...base, adjustment: signedByte(operands[0]) };
    case 0xe2: return { ...base, duration: operands[0], targetVolume: signedByte(operands[1]) };
    case 0xe3: return { ...base, rampValue: operands[0] };
    case 0xe4: return standardModulator(base, operands, 1, 'volume', 2);
    case 0xe5: return generalModulator(base, operands, 1, 'volume');
    case 0xe8: return { ...base, pan: operands[0] };
    case 0xe9: return { ...base, adjustment: signedByte(operands[0]) };
    case 0xea: return {
      ...base,
      duration: operands[0],
      targetPan: signedByte(operands[1]),
      terminalBehavior: 'retain-delta',
    };
    case 0xeb: return { ...base, rampValue: operands[0] };
    case 0xec: return standardModulator(base, operands, 2, 'pan', 3);
    case 0xed: return generalModulator(base, operands, 2, 'pan');
    case 0xf0: return {
      ...base,
      slot: modulatorSlot(operands[0], opcode),
      waveform: operands[1] & 0x0f,
      retriggerOnNote: (operands[1] & 0x10) === 0,
      target: modulatorTarget(operands[2], opcode),
    };
    case 0xf1: return {
      ...base,
      periodValue: operands[0],
      amplitude: signedBigEndianWord(operands[1], operands[2]),
    };
    case 0xf2: return { ...base, delay: operands[0], rampValue: operands[1] };
    case 0xf6:
    case 0xf7: return { ...base, slot: modulatorSlot(operands[0], opcode) };
    case 0xf8: return {
      ...base,
      startVolume: operands[0],
      duration: operands[1],
      targetVolume: operands[2],
    };
    case 0xf9: return { ...base, bar: operands[0], beat: operands[1] };
    case 0xfc: return { ...base, bankId: operands[0], presetIndex: operands[1] };
    case 0xfd: return { ...base, scale: operands[0] };
    case 0xfe: return { ...base, bankId: operands[0] };
    case 0xff: return { ...base, runtimeContext: 'spu-voice-envelope' };
    default: return base;
  }
}

function checkDeclaredCommand(reader, offset, length, declaredBytes, opcode) {
  if (offset + length > declaredBytes) {
    throw new XenoFormatError(
      'Audio command crosses the sequence declared byte range.',
      'AUDIO_COMMAND_OUTSIDE_DECLARED_RANGE',
      { offset, length, declaredBytes, opcode },
    );
  }
  reader.check(offset, length);
}

function decodeScript(reader, startOffset, declaredBytes, coverage, { allowRangeBoundary = false } = {}) {
  if (startOffset === 0) return null;
  if (startOffset >= declaredBytes) {
    throw new XenoFormatError('Audio script pointer is outside the sequence.', 'INVALID_AUDIO_SCRIPT_POINTER', {
      startOffset,
      declaredBytes,
    });
  }
  const commands = [];
  const unresolvedOpcodes = [];
  let offset = startOffset;
  for (let count = 0; count < declaredBytes; count += 1) {
    if (offset >= declaredBytes) {
      if (allowRangeBoundary) {
        return {
          startOffset,
          endOffset: offset,
          termination: 'range-boundary',
          commands,
          unresolvedOpcodes,
        };
      }
      throw new XenoFormatError('Audio script has no end command.', 'UNTERMINATED_AUDIO_SCRIPT', {
        startOffset,
      });
    }
    const opcode = reader.u8(offset);
    if (opcode < 0x80) {
      checkDeclaredCommand(reader, offset, 2, declaredBytes, opcode);
      const durationByte = reader.u8(offset + 1);
      if (durationByte >= DELTA_TIME_TABLE.length * 12) {
        throw new XenoFormatError('Audio note has an invalid pitch and duration selector.', 'INVALID_AUDIO_NOTE_SELECTOR', {
          offset,
          selector: durationByte,
        });
      }
      const durationIndex = durationByte % DELTA_TIME_TABLE.length;
      const length = durationIndex === 0 ? 3 : 2;
      checkDeclaredCommand(reader, offset, length, declaredBytes, opcode);
      const ticks = durationIndex === 0 ? reader.u8(offset + 2) : DELTA_TIME_TABLE[durationIndex];
      mark(coverage, offset, length, 'Audio note command');
      commands.push({
        offset,
        length,
        type: 'note',
        velocity: opcode,
        semitone: Math.floor(durationByte / DELTA_TIME_TABLE.length),
        durationIndex,
        ticks,
      });
      offset += length;
      continue;
    }

    const length = OPCODE_BYTES[opcode - 0x80];
    if (RESERVED_OPCODES.has(opcode)) {
      throw new XenoFormatError('Audio script reaches a reserved opcode.', 'RESERVED_AUDIO_OPCODE', {
        offset,
        opcode,
      });
    }
    if (length === 0) {
      throw new XenoFormatError('Audio script uses an opcode with no recovered size.', 'UNSIZED_AUDIO_OPCODE', {
        offset,
        opcode,
      });
    }
    checkDeclaredCommand(reader, offset, length, declaredBytes, opcode);
    mark(coverage, offset, length, 'Audio opcode');
    const operands = Array.from(reader.slice(offset + 1, length - 1));
    const semantic = COMPLETE_OPCODE_TYPES.has(opcode)
      ? semanticCommand(opcode, operands)
      : { type: 'unresolved-opcode', operands };
    commands.push({ offset, length, opcode, ...semantic });
    if (!COMPLETE_OPCODE_TYPES.has(opcode)) unresolvedOpcodes.push(opcode);
    offset += length;
    if (opcode === 0x90) {
      return {
        startOffset,
        endOffset: offset,
        termination: 'repeat-or-end',
        commands,
        unresolvedOpcodes,
      };
    }
  }
  throw new XenoFormatError('Audio script has no end command.', 'UNTERMINATED_AUDIO_SCRIPT', {
    startOffset,
  });
}

function recoverUnreferencedCommandRanges(reader, bytes, coverage, scripts, declaredBytes) {
  const terminalOffsets = new Set(scripts.filter((script) => (
    script?.termination === 'repeat-or-end'
  )).map(({ endOffset }) => endOffset));
  const entryOffsets = new Set(scripts.filter(Boolean).map(({ startOffset }) => startOffset));
  // A terminated last channel cannot reach trailing commands either. The
  // declared sequence boundary excludes alignment padding and adjacent assets.
  entryOffsets.add(declaredBytes);
  const candidates = rangesFromCoverage(coverage, bytes).unresolvedRanges;
  const recovered = [];

  for (const range of candidates) {
    const endOffset = range.offset + range.length;
    if (!terminalOffsets.has(range.offset) || !entryOffsets.has(endOffset)) continue;
    const scratchCoverage = new Uint8Array(coverage.length);
    let decoded;
    const commands = [];
    let cursor = range.offset;
    try {
      // A bounded unused region can contain several terminated fragments.
      // None is a channel entry, and the preceding active channel cannot fall
      // through its repeat/end command. Still decode every byte before accepting it.
      while (cursor < endOffset) {
        decoded = decodeScript(
          reader,
          cursor,
          endOffset,
          scratchCoverage,
          { allowRangeBoundary: true },
        );
        if (decoded.unresolvedOpcodes.length !== 0) break;
        commands.push(...decoded.commands);
        cursor = decoded.endOffset;
      }
    } catch (error) {
      if (error instanceof XenoFormatError) continue;
      throw error;
    }
    if (cursor !== endOffset || decoded.unresolvedOpcodes.length !== 0) continue;
    mark(coverage, range.offset, range.length, 'Unreferenced audio command range');
    recovered.push({
      range,
      runtimeUse: 'none',
      termination: decoded.termination,
      commands,
    });
  }
  return recovered;
}

function readCString(reader, offset, declaredBytes) {
  if (offset >= declaredBytes) {
    throw new XenoFormatError('Audio sequence name pointer is invalid.', 'INVALID_AUDIO_NAME_POINTER', { offset });
  }
  const values = [];
  for (let cursor = offset; cursor < declaredBytes; cursor += 1) {
    const value = reader.u8(cursor);
    if (value === 0) return { value: Buffer.from(values).toString('ascii'), length: values.length + 1 };
    if (value < 0x20 || value > 0x7e) {
      throw new XenoFormatError('Audio sequence name is not printable ASCII.', 'INVALID_AUDIO_NAME', {
        offset: cursor,
        value,
      });
    }
    values.push(value);
  }
  throw new XenoFormatError('Audio sequence name is unterminated.', 'UNTERMINATED_AUDIO_NAME', { offset });
}

function unresolvedOpcodeDiagnostic(scripts) {
  const counts = new Map();
  for (const script of scripts) {
    if (!script) continue;
    for (const opcode of script.unresolvedOpcodes) counts.set(opcode, (counts.get(opcode) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return {
    severity: 'error',
    code: 'UNRESOLVED_AUDIO_OPCODE_SEMANTICS',
    message: 'The sequence uses audio opcodes whose retail semantics are not yet proven.',
    details: {
      opcodes: [...counts.entries()].sort((left, right) => left[0] - right[0]).map(([opcode, count]) => ({
        opcode: `0x${opcode.toString(16).padStart(2, '0')}`,
        count,
      })),
    },
  };
}

function finalizeSequence(bytes, context, data, coverage, scripts, inputSha256) {
  const unreferencedCommandRanges = recoverUnreferencedCommandRanges(
    new BinaryReader(bytes, 'Audio sequence'),
    bytes,
    coverage,
    scripts,
    data.format.declaredBytes,
  );
  const { paddingRanges, unresolvedRanges } = rangesFromCoverage(coverage, bytes);
  const diagnostics = [];
  const opcodeDiagnostic = unresolvedOpcodeDiagnostic(scripts);
  if (opcodeDiagnostic) diagnostics.push(opcodeDiagnostic);
  if (unresolvedRanges.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'UNRESOLVED_AUDIO_SEQUENCE_RANGES',
      message: 'The sequence contains non-padding bytes outside recovered semantic structures.',
      details: { ranges: unresolvedRanges },
    });
  }
  if (sha256(bytes) !== inputSha256) throw new Error('Audio decoder mutated its input.');
  return validateCleanContentValue({
    schema: { name: 'xenogears-audio-sequence', version: AUDIO_RECORD_SCHEMA_VERSION },
    id: `${context.sourceId}:sequence`,
    complete: diagnostics.length === 0,
    decoder: { ...AUDIO_DECODER },
    source: sourceRecord(context),
    ...data,
    unreferencedCommandRanges,
    paddingRanges,
    unresolvedRanges,
    diagnostics,
  }, 'Audio sequence semantic decode');
}

function decodeMusicSequence(bytes, context, reader, declaredBytes, commonMarker, checksumValid, coverage, inputSha256) {
  const sequenceTag = reader.u16(0x10);
  if (reader.u16(0x12) !== 0x0102) {
    throw new XenoFormatError('SMDS sequence type is invalid.', 'INVALID_SMDS_SEQUENCE_TYPE', {
      value: reader.u16(0x12),
    });
  }
  const trackCount = reader.u8(0x14);
  const percussionCount = reader.u8(0x15);
  const nameOffset = reader.u16(0x1e);
  const percussionOffset = reader.u16(0x20);
  const tableEnd = 0x22 + trackCount * 2;
  if (nameOffset !== tableEnd + 2) {
    throw new XenoFormatError('SMDS track table and name ranges are inconsistent.', 'INVALID_SMDS_LAYOUT', {
      trackCount,
      nameOffset,
      tableEnd,
    });
  }
  mark(coverage, 0, tableEnd + 2, 'SMDS header and track table');
  const name = readCString(reader, nameOffset, declaredBytes);
  mark(coverage, nameOffset, name.length, 'SMDS name');
  if (percussionOffset < nameOffset + name.length) {
    throw new XenoFormatError('SMDS percussion table overlaps its name.', 'INVALID_SMDS_LAYOUT', {
      percussionOffset,
    });
  }
  mark(coverage, percussionOffset, percussionCount * 5, 'SMDS percussion table');

  const percussion = [];
  for (let index = 0; index < percussionCount; index += 1) {
    const offset = percussionOffset + index * 5;
    const mappingIndex = reader.u8(offset);
    if (mappingIndex >= 96) {
      throw new XenoFormatError('SMDS percussion mapping index is invalid.', 'INVALID_SMDS_PERCUSSION_INDEX', {
        index,
        mappingIndex,
      });
    }
    percussion.push({
      index,
      mappingIndex,
      presetIndex: reader.u8(offset + 1),
      replacementNote: reader.u8(offset + 2),
      retailIgnoredValue: reader.u8(offset + 3),
      pan: reader.u8(offset + 4),
    });
  }

  const tracks = [];
  const scripts = [];
  let firstScriptOffset = declaredBytes;
  for (let index = 0; index < trackCount; index += 1) {
    const startOffset = reader.u16(0x22 + index * 2);
    if (startOffset !== 0) firstScriptOffset = Math.min(firstScriptOffset, startOffset);
    const script = decodeScript(reader, startOffset, declaredBytes, coverage);
    scripts.push(script);
    tracks.push({ index, active: script !== null, startOffset, commands: script?.commands ?? [] });
  }
  if (firstScriptOffset !== percussionOffset + percussionCount * 5) {
    throw new XenoFormatError('SMDS semantic tables do not end at the first track.', 'INVALID_SMDS_LAYOUT', {
      firstScriptOffset,
      expected: percussionOffset + percussionCount * 5,
    });
  }

  return finalizeSequence(bytes, context, {
    kind: 'music-sequence',
    format: {
      magic: 'smds',
      commonMarker,
      sequenceTag,
      formatMarker: reader.u16(0x12),
      checksum: reader.u32(0x04),
      checksumValid,
      declaredBytes,
      trackTableTrailer: reader.u16(tableEnd),
    },
    sampleBankId: reader.u16(0x16),
    runtimeUnusedInitialScalar: reader.u16(0x18),
    reverb: {
      type: signedByte(reader.u8(0x1a)),
      depth: reader.u8(0x1b),
      delay: signedByte(reader.u8(0x1c)),
      feedback: signedByte(reader.u8(0x1d)),
    },
    name: name.value,
    percussion,
    tracks,
  }, coverage, scripts, inputSha256);
}

function decodeEffectSequence(bytes, context, reader, declaredBytes, commonMarker, coverage, inputSha256) {
  const policyFlags = reader.u16(0x10);
  if ((policyFlags & ~1) !== 0) {
    throw new XenoFormatError('SEDS effect policy has unsupported flags.', 'INVALID_SEDS_POLICY_FLAGS', {
      policyFlags,
    });
  }
  const effectCount = reader.u16(0x12);
  const volumeOffset = reader.u32(0x18);
  requireZero(reader.u32(0x1c), 'SEDS linked-list placeholder', 0x1c);
  const pointerTableEnd = 0x20 + effectCount * 4;
  if (volumeOffset !== pointerTableEnd) {
    throw new XenoFormatError('SEDS pointer and volume tables are inconsistent.', 'INVALID_SEDS_LAYOUT', {
      effectCount,
      volumeOffset,
      pointerTableEnd,
    });
  }
  mark(coverage, 0, pointerTableEnd, 'SEDS header and channel table');
  mark(coverage, volumeOffset, effectCount, 'SEDS volume table');

  const scripts = [];
  const effects = [];
  let firstScriptOffset = declaredBytes;
  for (let effectIndex = 0; effectIndex < effectCount; effectIndex += 1) {
    const channels = [];
    for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
      const startOffset = reader.u16(0x20 + (effectIndex * 2 + channelIndex) * 2);
      if (startOffset !== 0) firstScriptOffset = Math.min(firstScriptOffset, startOffset);
      const script = decodeScript(reader, startOffset, declaredBytes, coverage);
      scripts.push(script);
      channels.push({ channelIndex, active: script !== null, startOffset, commands: script?.commands ?? [] });
    }
    effects.push({
      index: effectIndex,
      volume: reader.u8(volumeOffset + effectIndex),
      channels,
    });
  }
  if (firstScriptOffset !== volumeOffset + effectCount) {
    throw new XenoFormatError('SEDS semantic tables do not end at the first script.', 'INVALID_SEDS_LAYOUT', {
      firstScriptOffset,
      expected: volumeOffset + effectCount,
    });
  }

  return finalizeSequence(bytes, context, {
    kind: 'sound-effect-sequence',
    format: {
      magic: 'seds',
      commonMarker,
      checksum: reader.u32(0x04),
      checksumValid: true,
      declaredBytes,
    },
    effectPolicy: {
      rawFlags: policyFlags,
      suppressSequenceReverbEnable: (policyFlags & 1) !== 0,
    },
    sedsId: reader.u16(0x14),
    sampleBankId: reader.u16(0x16),
    effects,
  }, coverage, scripts, inputSha256);
}

export function decodeSoundSequence(value, context) {
  const bytes = sourceBytes(value, 'Audio sequence');
  assertSourceContext(bytes, context);
  const inputSha256 = sha256(bytes);
  const reader = new BinaryReader(bytes, 'Audio sequence');
  reader.check(0, 0x22);
  const magic = ascii(reader, 0, 4);
  if (magic !== 'smds' && magic !== 'seds') {
    throw new XenoFormatError('Audio sequence signature is invalid.', 'INVALID_AUDIO_MAGIC', {
      expected: ['smds', 'seds'],
    });
  }
  const declaredBytes = reader.u32(0x08);
  const storedBytes = Math.ceil(declaredBytes / 4) * 4;
  if (declaredBytes < 0x22 || storedBytes !== bytes.byteLength) {
    throw new XenoFormatError('Audio sequence declared size is inconsistent.', 'INVALID_AUDIO_SEQUENCE_SIZE', {
      declaredBytes,
      storedBytes: bytes.byteLength,
    });
  }
  for (let offset = declaredBytes; offset < storedBytes; offset += 1) {
    if (reader.u8(offset) !== 0) {
      throw new XenoFormatError('Audio sequence alignment padding is nonzero.', 'INVALID_AUDIO_PADDING', {
        offset,
      });
    }
  }
  const commonMarker = reader.u32(0x0c);
  const checksumValid = additiveWordChecksum(reader, storedBytes) === 0;
  if (magic === 'seds') {
    requireVersion(reader, 'SEDS');
    requireChecksum(reader, storedBytes, 'SEDS');
  }
  const coverage = new Uint8Array(storedBytes);
  if (storedBytes > declaredBytes) mark(coverage, declaredBytes, storedBytes - declaredBytes, 'Sequence alignment padding');
  return magic === 'smds'
    ? decodeMusicSequence(
      bytes,
      context,
      reader,
      declaredBytes,
      commonMarker,
      checksumValid,
      coverage,
      inputSha256,
    )
    : decodeEffectSequence(bytes, context, reader, declaredBytes, commonMarker, coverage, inputSha256);
}
