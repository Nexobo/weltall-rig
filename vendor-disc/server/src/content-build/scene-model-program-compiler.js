export const SCENE_MODEL_PROGRAM_SCHEMA_VERSION = 1;

const MULTIWORD_INSTRUCTIONS = new Map([
  ...[
    0x01, 0x11, 0x14, 0x15, 0x18, 0x22, 0x23, 0x28, 0x29, 0x2e, 0x30, 0x31,
    0x32, 0x33, 0x34, 0x35, 0x37, 0x38, 0x39, 0x3b, 0x3c, 0x54, 0x55, 0x56,
    0x5c, 0x5d, 0x5e, 0x5f, 0x63, 0x64, 0x6b, 0x6e, 0x70,
  ].map((opcode) => [opcode, 2]),
  ...[0x13, 0x36].map((opcode) => [opcode, 3]),
  ...[0x40, 0x41, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4b, 0x4c, 0x4d, 0x4e, 0x50]
    .map((opcode) => [opcode, 4]),
  ...[0x25, 0x62].map((opcode) => [opcode, 5]),
  [0x1a, 7],
  [0x1d, 10],
]);

const RESERVED_NOOPS = new Set([
  0x04, 0x05, 0x06, 0x07, 0x09, 0x0f, 0x12, 0x1b, 0x1c, 0x2c, 0x2d, 0x2f,
  0x33, 0x34, 0x3a, 0x3b, 0x3e, 0x3f, 0x51, 0x52, 0x53, 0x58, 0x59, 0x5a,
  0x60, 0x61, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a,
]);

const CHANNEL_NAMES = ['rotation', 'translation', 'scale'];
const AXIS_NAMES = ['x', 'y', 'z'];
const TRANSFORM_TRACK_MODES = ['linear-delta', 'approach-target', 'accelerated'];
const TIMED_EVENT_TYPES = new Map([
  [1, { operation: 'reserved-effect-event' }],
  [2, { operation: 'image-slot', requiredContext: 'timed-image-slot' }],
  [3, { operation: 'trail-emitter', requiredContext: 'timed-trail-emitter' }],
  [4, { operation: 'trail-emitter', requiredContext: 'timed-trail-emitter' }],
  [5, { operation: 'reserved-sound-event' }],
  [6, { operation: 'reserved-command-event' }],
  [7, { operation: 'bone-visibility' }],
  [8, { operation: 'linked-model-dispatch', requiredContext: 'timed-linked-models' }],
  [9, { operation: 'image-animation', requiredContext: 'timed-image-animation' }],
]);

function asBytes(value) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Scene-model program compiler requires parsed animation bytes.');
}

function readU16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.byteLength) {
    throw new RangeError('Scene-model program read exceeds its source.');
  }
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readI16(bytes, offset) {
  const value = readU16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function signedWord(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

function signedByte(value) {
  const byte = value & 0xff;
  return byte & 0x80 ? byte - 0x100 : byte;
}

function vectorFromWords(words, offset) {
  return words.slice(offset, offset + 3).map(signedWord);
}

function vectorFromBytes(bytes, offset) {
  return [readI16(bytes, offset), readI16(bytes, offset + 2), readI16(bytes, offset + 4)];
}

function diagnostic(code, message, details = {}) {
  return { code, message, details };
}

function addContext(contexts, requiredContext) {
  if (requiredContext) contexts.add(requiredContext);
  return requiredContext;
}

function genericOperands(words, start = 1) {
  return words.slice(start).map((value, index) => ({
    name: `operand-${index + start}`,
    type: 'unsigned-word',
    value,
  }));
}

function keyframeReference(selector, keyframes, contexts, diagnostics, scriptIndex, wordOffset) {
  if (selector >= 0xfe) {
    addContext(contexts, 'dynamic-keyframe-selector');
    diagnostics.push(diagnostic(
      'DYNAMIC_SCENE_MODEL_KEYFRAME_UNRESOLVED',
      `Script ${scriptIndex} selects a keyframe from unresolved runtime state.`,
      { scriptIndex, wordOffset, selector },
    ));
    return { kind: 'dynamic', value: selector };
  }
  if (selector >= 0x40) {
    addContext(contexts, 'external-keyframe-table');
    diagnostics.push(diagnostic(
      'EXTERNAL_SCENE_MODEL_KEYFRAME_UNRESOLVED',
      `Script ${scriptIndex} references an external keyframe table that is not normalized.`,
      { scriptIndex, wordOffset, selector },
    ));
    return { kind: 'external', value: selector };
  }
  if (!keyframes[selector]) {
    diagnostics.push(diagnostic(
      'MISSING_SCENE_MODEL_KEYFRAME',
      `Script ${scriptIndex} references absent local keyframe ${selector}.`,
      { scriptIndex, wordOffset, keyframeIndex: selector },
    ));
  }
  return { kind: 'local', value: selector };
}

function instructionWidth(opcode) {
  return MULTIWORD_INSTRUCTIONS.get(opcode) ?? 1;
}

function baseInstruction(wordOffset, words, opcode, operation) {
  return {
    wordOffset,
    wordLength: words.length,
    opcode,
    operation,
    parameters: {},
    contextRequest: null,
    controlFlow: {
      kind: 'fallthrough',
      nextWordOffset: wordOffset + words.length,
      targetWordOffsets: [],
    },
  };
}

function compileInstruction(script, scriptIndex, wordOffset, keyframes, contexts, diagnostics) {
  const instruction = script[wordOffset];
  if (instruction === 0x7777) {
    const record = baseInstruction(wordOffset, [instruction], 0x77, 'end-marker');
    record.controlFlow = { kind: 'stop', nextWordOffset: null, targetWordOffsets: [] };
    return record;
  }

  const opcode = instruction & 0xff;
  const argument = instruction >> 8;
  const width = instructionWidth(opcode);
  const words = script.slice(wordOffset, wordOffset + width);
  if (words.length !== width) {
    diagnostics.push(diagnostic(
      'TRUNCATED_SCENE_MODEL_INSTRUCTION',
      `Script ${scriptIndex} ends inside opcode 0x${opcode.toString(16).padStart(2, '0')}.`,
      { scriptIndex, wordOffset, opcode, expectedWords: width, actualWords: words.length },
    ));
    const record = baseInstruction(wordOffset, words, opcode, 'invalid');
    record.controlFlow = { kind: 'blocked', nextWordOffset: null, targetWordOffsets: [] };
    return record;
  }

  if (RESERVED_NOOPS.has(opcode)) {
    const record = baseInstruction(wordOffset, words, opcode, 'reserved-noop');
    record.parameters = { argument, operands: genericOperands(words) };
    return record;
  }

  const record = baseInstruction(wordOffset, words, opcode, 'unsupported');
  switch (opcode) {
    case 0x00:
      record.operation = 'stop';
      record.controlFlow = { kind: 'stop', nextWordOffset: null, targetWordOffsets: [] };
      break;
    case 0x01:
      record.operation = 'wait';
      record.parameters = { durationTicks: words[1] };
      record.controlFlow.kind = 'wait';
      break;
    case 0x08:
      record.operation = 'release-animation-tracks';
      break;
    case 0x0a:
    case 0x0d:
    case 0x0e:
      record.operation = 'release-bone-tracks';
      record.parameters = {
        boneIndex: argument,
        channels: opcode === 0x0a ? [...CHANNEL_NAMES] : [opcode === 0x0d ? 'rotation' : 'translation'],
      };
      break;
    case 0x0c:
      record.operation = 'clear-pending-motion';
      break;
    case 0x10:
      record.operation = 'apply-keyframe-pose';
      record.parameters = {
        keyframe: keyframeReference(argument, keyframes, contexts, diagnostics, scriptIndex, wordOffset),
      };
      break;
    case 0x11: {
      const options = words[1];
      record.operation = 'bind-keyframe-stream';
      record.parameters = {
        keyframe: keyframeReference(argument, keyframes, contexts, diagnostics, scriptIndex, wordOffset),
        looping: ((options >> 8) & 1) !== 0,
        owner: signedByte(options),
      };
      break;
    }
    case 0x13: {
      const frame = words[1];
      const options = words[2];
      record.operation = 'bind-keyframe-transition';
      record.parameters = {
        keyframe: keyframeReference(frame & 0xff, keyframes, contexts, diagnostics, scriptIndex, wordOffset),
        interpolation: (argument & 1) === 0 ? 'linear-delta' : 'approach-target',
        durationTicks: options >> 8,
        looping: (options & 0xff) !== 0,
        owner: signedByte(frame >> 8),
      };
      break;
    }
    case 0x19:
      record.operation = 'clear-timed-events';
      break;
    case 0x1a: {
      const rawWidth = signedWord(words[5]);
      const requiredContext = addContext(contexts, 'vram-rectangle-move');
      record.operation = 'move-vram-rectangle';
      record.parameters = {
        adjustTextureOrigin: (argument & 1) !== 0,
        source: {
          x: signedWord(words[1]),
          y: signedWord(words[2]),
          width: signedWord((rawWidth + 1 + (rawWidth < -1 ? 1 : 0)) & 0xfffe),
          height: signedWord(words[6]),
        },
        destination: { x: signedWord(words[3]), y: signedWord(words[4]) },
      };
      record.contextRequest = { requiredContext };
      break;
    }
    case 0x1d: {
      const flagsAndMode = words[1];
      const ownerAndLoop = words[2];
      const channel = flagsAndMode & 7;
      const mode = (flagsAndMode >> 8) + 3;
      record.operation = 'bind-transform-track';
      record.parameters = {
        boneIndex: argument,
        channel: CHANNEL_NAMES[channel] ?? `channel-${channel}`,
        mode: TRANSFORM_TRACK_MODES[mode - 3] ?? `mode-${mode}`,
        includeDescendants: (flagsAndMode & 0x80) !== 0,
        startRelative: (flagsAndMode & 0x20) !== 0,
        endRelative: (flagsAndMode & 0x40) !== 0,
        owner: signedByte(ownerAndLoop),
        looping: (ownerAndLoop >> 8) !== 0,
        start: vectorFromWords(words, 3),
        end: vectorFromWords(words, 6),
        durationTicks: words[9],
      };
      if (channel > 2 || mode > 5) {
        diagnostics.push(diagnostic(
          'INVALID_SCENE_MODEL_TRANSFORM_TRACK',
          `Script ${scriptIndex} contains an invalid transform-track selector.`,
          { scriptIndex, wordOffset, channel, mode },
        ));
      }
      break;
    }
    case 0x1e:
      record.operation = 'set-skeleton-update-mode';
      record.parameters = { mode: argument };
      break;
    case 0x21:
      record.operation = 'wait-for-track-owner';
      record.parameters = { owner: signedByte(argument) };
      record.controlFlow.kind = 'wait';
      break;
    case 0x23:
      record.operation = 'set-bone-visibility';
      record.parameters = {
        boneIndex: words[1],
        enabled: (argument & 1) !== 0,
        includeDescendants: (argument & 0x80) !== 0,
      };
      break;
    case 0x32: {
      const byteOffset = signedWord(words[1]);
      const target = wordOffset + byteOffset / 2;
      record.operation = 'jump';
      record.parameters = { relativeByteOffset: byteOffset };
      record.controlFlow = { kind: 'branch', nextWordOffset: null, targetWordOffsets: [target] };
      if ((byteOffset & 1) !== 0 || target < 0 || target >= script.length) {
        diagnostics.push(diagnostic(
          'INVALID_SCENE_MODEL_BRANCH',
          `Script ${scriptIndex} contains an invalid branch.`,
          { scriptIndex, wordOffset, byteOffset, targetWordOffset: target },
        ));
      }
      break;
    }
    case 0x37: {
      const byteOffset = signedWord(words[1]);
      const target = wordOffset + byteOffset / 2;
      const requiredContext = argument === 0
        ? null
        : addContext(contexts, 'target-ground-callback');
      record.operation = 'set-target-ground-callback';
      record.parameters = { enabled: argument !== 0, flags: argument, relativeByteOffset: byteOffset };
      record.contextRequest = argument === 0 ? null : { requiredContext };
      record.controlFlow = {
        kind: argument === 0 ? 'fallthrough' : 'runtime-callback',
        nextWordOffset: wordOffset + width,
        targetWordOffsets: [target],
      };
      if ((byteOffset & 1) !== 0 || target < 0 || target >= script.length) {
        diagnostics.push(diagnostic(
          'INVALID_SCENE_MODEL_CALLBACK_BRANCH',
          `Script ${scriptIndex} contains an invalid ground-callback branch.`,
          { scriptIndex, wordOffset, byteOffset, targetWordOffset: target },
        ));
      }
      break;
    }
    case 0x40:
    case 0x41:
      record.operation = opcode === 0x40 ? 'set-root-rotation' : 'add-root-rotation';
      record.parameters = { durationTicks: argument, value: vectorFromWords(words, 1) };
      break;
    case 0x44:
    case 0x45:
    case 0x46:
    case 0x47:
    case 0x4b:
    case 0x4c:
    case 0x4d:
    case 0x4e: {
      const names = {
        0x44: 'set-pending-rotation',
        0x45: 'add-pending-rotation',
        0x46: 'set-pending-rotation-velocity',
        0x47: 'add-pending-rotation-velocity',
        0x4b: 'set-pending-translation',
        0x4c: 'add-pending-translation',
        0x4d: 'set-pending-translation-velocity',
        0x4e: 'add-pending-translation-velocity',
      };
      record.operation = names[opcode];
      record.parameters = { value: vectorFromWords(words, 1) };
      break;
    }
    case 0x48:
      record.operation = 'set-altitude-mode';
      record.parameters = { mode: argument };
      break;
    case 0x49:
      record.operation = 'set-root-translation';
      record.parameters = { value: vectorFromWords(words, 1) };
      break;
    case 0x62: {
      const channel = argument & 7;
      record.operation = 'apply-direct-transform';
      record.parameters = {
        boneIndex: words[1],
        channel: CHANNEL_NAMES[channel] ?? `channel-${channel}`,
        additive: (argument & 0x20) !== 0,
        includeDescendants: (argument & 0x80) !== 0,
        value: vectorFromWords(words, 2),
      };
      if (channel > 2) {
        diagnostics.push(diagnostic(
          'INVALID_SCENE_MODEL_TRANSFORM_CHANNEL',
          `Script ${scriptIndex} selects invalid transform channel ${channel}.`,
          { scriptIndex, wordOffset, channel },
        ));
      }
      break;
    }
    case 0x64:
      record.operation = 'set-animation-state';
      record.parameters = { value: signedWord(words[1]) };
      break;
    case 0x6b:
      record.operation = 'set-bone-rotation-order';
      record.parameters = { boneIndex: words[1], order: argument };
      break;
    default:
      record.parameters = { argument, operands: genericOperands(words) };
      record.controlFlow = { kind: 'blocked', nextWordOffset: null, targetWordOffsets: [] };
      diagnostics.push(diagnostic(
        'UNSUPPORTED_SCENE_MODEL_OPCODE',
        `Script ${scriptIndex} contains unsupported opcode 0x${opcode.toString(16).padStart(2, '0')}.`,
        { scriptIndex, wordOffset, opcode },
      ));
      break;
  }
  return record;
}

function compileScript(words, scriptIndex, keyframes, allContexts, diagnostics) {
  const contexts = new Set();
  const instructions = [];
  let wordOffset = 0;
  while (wordOffset < words.length) {
    const instruction = compileInstruction(
      words,
      scriptIndex,
      wordOffset,
      keyframes,
      contexts,
      diagnostics,
    );
    instructions.push(instruction);
    if (instruction.wordLength === 0) break;
    wordOffset += instruction.wordLength;
  }

  const boundaries = new Set(instructions.map((instruction) => instruction.wordOffset));
  for (const instruction of instructions) {
    for (const target of instruction.controlFlow.targetWordOffsets) {
      if (Number.isInteger(target) && !boundaries.has(target)) {
        diagnostics.push(diagnostic(
          'MISALIGNED_SCENE_MODEL_BRANCH_TARGET',
          `Script ${scriptIndex} branches into the middle of an instruction.`,
          { scriptIndex, wordOffset: instruction.wordOffset, targetWordOffset: target },
        ));
      }
    }
  }
  contexts.forEach((value) => allContexts.add(value));
  return {
    index: scriptIndex,
    wordCount: words.length,
    requiredContexts: [...contexts].sort(),
    instructions,
  };
}

function compileTimedEvent(event, contexts) {
  const definition = TIMED_EVENT_TYPES.get(event.type);
  if (!definition) {
    return {
      index: event.index,
      frame: event.frame,
      slot: event.slot,
      operation: 'unsupported',
      parameters: { operands: event.payload.map((value, index) => ({ name: `byte-${index}`, type: 'byte', value })) },
      contextRequest: null,
    };
  }

  let requiredContext = definition.requiredContext ?? null;
  let parameters;
  if (event.type === 7) {
    parameters = { boneIndex: event.payload[0], enabled: (event.payload[1] & 1) !== 0 };
    if (event.slot !== 0) requiredContext = 'timed-event-target-model';
  } else if (event.type === 8) {
    parameters = {
      dispatchMode: event.payload[0],
      animationCandidates: event.payload.slice(1),
    };
  } else {
    parameters = {
      operands: event.payload.map((value, index) => ({ name: `byte-${index}`, type: 'byte', value })),
    };
  }
  addContext(contexts, requiredContext);
  return {
    index: event.index,
    frame: event.frame,
    slot: event.slot,
    operation: definition.operation,
    parameters,
    contextRequest: requiredContext ? { requiredContext } : null,
  };
}

function compileDirectPose(bytes, keyframe, cursor, nodeCount) {
  const rotations = [];
  const translations = [];
  let rotationIndex = 0;
  let translationIndex = 0;
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    if ((keyframe.flags & 1) === 0 && rotationIndex < keyframe.rotationCount) {
      rotations.push({ nodeIndex, value: vectorFromBytes(bytes, cursor) });
      cursor += 6;
      rotationIndex += 1;
    }
    if ((keyframe.flags & 2) === 0 && translationIndex < keyframe.translationCount) {
      translations.push({ nodeIndex, value: vectorFromBytes(bytes, cursor) });
      cursor += 6;
      translationIndex += 1;
    }
  }
  return { rotations, translations, cursor };
}

function decodeTrack(bytes, keyframe, descriptor, channel, streamBase, boundary, diagnostics) {
  const relativeOffset = readU16(bytes, descriptor.offset + (channel === 0 ? 0 : 2));
  if (relativeOffset === 0xffff) return null;
  const encoding = bytes[descriptor.offset + (channel === 0 ? 4 : 5)];
  const modeValue = encoding & 0x0f;
  const mode = modeValue === 0
    ? 'absolute'
    : modeValue === 1
      ? 'delta-or-absolute'
      : channel === 1 && modeValue === 2
        ? 'local-delta'
        : null;
  if (!mode) {
    diagnostics.push(diagnostic(
      'UNSUPPORTED_SCENE_MODEL_TRACK_MODE',
      `Keyframe ${keyframe.index} uses unsupported ${CHANNEL_NAMES[channel]} track mode ${modeValue}.`,
      { keyframeIndex: keyframe.index, boneIndex: descriptor.boneIndex, channel, mode: modeValue },
    ));
    return {
      boneIndex: descriptor.boneIndex,
      channel: CHANNEL_NAMES[channel],
      mode: 'unsupported',
      axes: [],
      samples: [],
      storageBytes: boundary - (streamBase + relativeOffset),
      unusedStorageBytes: boundary - (streamBase + relativeOffset),
    };
  }

  const axes = AXIS_NAMES.filter((_, axis) => (encoding & (0x10 << axis)) === 0);
  const samples = [];
  let cursor = streamBase + relativeOffset;
  const sampleCount = Math.max(1, keyframe.duration);
  for (let tick = 0; tick < sampleCount; tick += 1) {
    const values = [];
    for (const axis of axes) {
      if (modeValue === 0 || modeValue === 2) {
        values.push({ axis, operation: modeValue === 0 ? 'set' : 'local-delta', value: readI16(bytes, cursor) });
        cursor += 2;
      } else {
        if (cursor >= bytes.byteLength) throw new RangeError('Scene-model animation track is truncated.');
        const value = bytes[cursor];
        cursor += 1;
        if (value === 0x80) {
          values.push({ axis, operation: 'set', value: readI16(bytes, cursor) });
          cursor += 2;
        } else {
          values.push({ axis, operation: 'add', value: signedByte(value) });
        }
      }
    }
    samples.push({ tick, values });
  }

  if (cursor > boundary) {
    diagnostics.push(diagnostic(
      'OVERLAPPING_SCENE_MODEL_TRACKS',
      `Keyframe ${keyframe.index} track data overlaps the next stream.`,
      { keyframeIndex: keyframe.index, boneIndex: descriptor.boneIndex, channel: CHANNEL_NAMES[channel] },
    ));
  }
  return {
    boneIndex: descriptor.boneIndex,
    channel: CHANNEL_NAMES[channel],
    mode,
    axes,
    samples,
    storageBytes: boundary - (streamBase + relativeOffset),
    unusedStorageBytes: Math.max(0, boundary - cursor),
  };
}

function compileKeyframe(bytes, keyframe, nodeCount, contexts, diagnostics) {
  if (keyframe === null) return null;
  const eventStart = keyframe.eventCount > 0
    ? keyframe.offset + keyframe.eventOffset
    : keyframe.end;
  const descriptorCount = keyframe.mode === 0 ? keyframe.rotationCount + 1 : 0;
  const descriptorBytes = descriptorCount * 6;
  const directStart = keyframe.dataOffset + descriptorBytes;
  const direct = compileDirectPose(bytes, keyframe, directStart, nodeCount);
  const events = keyframe.events.map((event) => compileTimedEvent(event, contexts));
  const tracks = [];
  let unusedStorageBytes = Math.max(0, eventStart - direct.cursor);
  if (direct.cursor > eventStart) {
    diagnostics.push(diagnostic(
      'OVERLAPPING_SCENE_MODEL_KEYFRAME_DATA',
      `Keyframe ${keyframe.index} pose data overlaps its event stream.`,
      { keyframeIndex: keyframe.index },
    ));
  }

  if (keyframe.mode === 0) {
    const streamBase = direct.cursor;
    const descriptors = Array.from({ length: descriptorCount }, (_, boneIndex) => ({
      boneIndex,
      offset: keyframe.dataOffset + boneIndex * 6,
    }));
    const starts = [];
    for (const descriptor of descriptors) {
      for (let channel = 0; channel < 2; channel += 1) {
        const relativeOffset = readU16(bytes, descriptor.offset + (channel === 0 ? 0 : 2));
        if (relativeOffset !== 0xffff) starts.push(streamBase + relativeOffset);
      }
    }
    const orderedStarts = [...new Set(starts)].sort((left, right) => left - right);
    if (orderedStarts.some((start) => start < streamBase || start >= eventStart)) {
      diagnostics.push(diagnostic(
        'INVALID_SCENE_MODEL_TRACK_OFFSET',
        `Keyframe ${keyframe.index} has a track outside its stream area.`,
        { keyframeIndex: keyframe.index },
      ));
    } else {
      for (const descriptor of descriptors) {
        for (let channel = 0; channel < 2; channel += 1) {
          const relativeOffset = readU16(bytes, descriptor.offset + (channel === 0 ? 0 : 2));
          if (relativeOffset === 0xffff) continue;
          const start = streamBase + relativeOffset;
          const boundary = orderedStarts.find((candidate) => candidate > start) ?? eventStart;
          const track = decodeTrack(
            bytes,
            keyframe,
            descriptor,
            channel,
            streamBase,
            boundary,
            diagnostics,
          );
          if (track) tracks.push(track);
        }
      }
    }
    unusedStorageBytes = tracks.reduce((total, track) => total + track.unusedStorageBytes, 0);
  } else if (keyframe.mode !== 1) {
    diagnostics.push(diagnostic(
      'UNSUPPORTED_SCENE_MODEL_KEYFRAME_MODE',
      `Keyframe ${keyframe.index} uses unsupported layout ${keyframe.mode}.`,
      { keyframeIndex: keyframe.index, mode: keyframe.mode },
    ));
  }

  return {
    index: keyframe.index,
    layout: keyframe.mode === 0 ? 'streams-and-pose' : keyframe.mode === 1 ? 'pose' : 'unsupported',
    boneCount: keyframe.boneCount,
    durationTicks: keyframe.duration,
    flags: keyframe.flags,
    metadata08: readU16(bytes, keyframe.offset + 8),
    metadata0a: readU16(bytes, keyframe.offset + 0x0a),
    movementDistance: keyframe.movementDistance,
    directPose: { rotations: direct.rotations, translations: direct.translations },
    tracks,
    events,
    unusedStorageBytes,
  };
}

function clonePose(pose) {
  return {
    rotations: pose.rotations.map((value) => [...value]),
    translations: pose.translations.map((value) => [...value]),
    scales: pose.scales.map((value) => [...value]),
    visible: [...pose.visible],
  };
}

// Auxiliary animations update an already loaded skeleton. Their stored channels
// can be compiled without inventing a model hierarchy or an initial pose.
export function compileSceneModelAnimationKeyframe(value, keyframe) {
  const bytes = asBytes(value);
  const contexts = new Set();
  const diagnostics = [];
  const nodeCount = keyframe === null
    ? 0
    : Math.max(keyframe.rotationCount, keyframe.translationCount);
  return {
    keyframe: compileKeyframe(bytes, keyframe, nodeCount, contexts, diagnostics),
    requiredContexts: [...contexts].sort(),
    diagnostics,
  };
}

export function compileSceneModelAnimationProgram(program) {
  if (program?.type !== 'xenogears-scene-model-animation-program' || program.version !== 1) {
    throw new TypeError('Scene-model program compiler requires a parsed retail program.');
  }
  const bytes = asBytes(program.buffer);
  const contexts = new Set();
  const diagnostics = [];
  const keyframes = program.keyframes.map((keyframe) => (
    compileKeyframe(bytes, keyframe, program.nodes.length, contexts, diagnostics)
  ));
  const scripts = program.scripts.map((words, index) => (
    compileScript(words, index, program.keyframes, contexts, diagnostics)
  ));
  return {
    schema: { name: 'xenogears-scene-model-animation-program', version: SCENE_MODEL_PROGRAM_SCHEMA_VERSION },
    fps: program.fps,
    modelScale: program.modelScale,
    boneCount: program.nodes.length,
    defaultPose: clonePose(program.defaultPose),
    keyframes,
    scripts,
    requiredContexts: [...contexts].sort(),
    diagnostics,
  };
}
