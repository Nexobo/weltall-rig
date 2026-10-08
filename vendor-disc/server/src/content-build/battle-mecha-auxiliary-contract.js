import crypto from 'node:crypto';

import { validateCleanContentValue } from '../../../shared/content/content-schema.js';
import { decompressLzsFile } from '../xeno/lzs.js';
import { assertSourceContext } from './source-input.js';

export const BATTLE_MECHA_AUXILIARY_CONTRACT_DECODER = Object.freeze({
  id: 'battle-mecha-auxiliary-contract',
  revision: 1,
});

const LOAD_ADDRESS = 0x8006faf0;
const STORED_SHA256 = 'b9c3a15bf5f3eb06bcb3824ef62793b9a500fe1dcb3717fe8963e23e9f27628b';
const EXPANDED_SHA256 = '1830b4ef1fe37129972fc310dfad534f8161d6c0b123e74254c3711334a3e291';
const DISC_EVIDENCE = Object.freeze({
  1: {
    firstFlatIndex: 3149,
    overlayFlatIndex: 38,
    executableFlatIndex: 22,
    executableSha256: 'dc0b2dd786203d4cce5927c5a3fc85a18f39a3f7406078860076ebb0bbae7119',
    sourceIndexSha256: 'b8da57edfc2cc8866e6d456b6b64984b122b355b3799373b1f88045054f7aad5',
    archiveHeaderSha256: '610b2c7c2322e8dadeb5f87ace961e4e7dc55378e479a5b1239343225717fc67',
  },
  2: {
    firstFlatIndex: 3144,
    overlayFlatIndex: 33,
    executableFlatIndex: 17,
    executableSha256: '3246e15f4040305b280adae06bc7bb908ee882794183bec9fc23e71d85c19c35',
    sourceIndexSha256: 'e3ddbeb4e59dac4690c4ab6938ce0926c622ec3a53ad62110c91b26e73120b65',
    archiveHeaderSha256: 'fd8aff8403d852ce4384fcec547a5f23179e3d2d157157f572943f4ee0349788',
  },
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Recover the auxiliary-resource behavior of the authenticated Battle VM. */
export function decodeBattleMechaAuxiliaryContract(value, context) {
  assertSourceContext(value, context);
  const disc = DISC_EVIDENCE[context.discNumber];
  if (
    context.flatIndex !== disc.overlayFlatIndex
    || context.directoryOrdinal !== 3
    || context.fileIndex !== 3
    || context.storageLayout !== 'ordinary'
    || value.byteLength !== 166_564
    || context.sha256 !== STORED_SHA256
  ) throw new Error('Auxiliary mecha contract requires the authenticated retail Battle overlay occurrence.');

  const stored = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const image = decompressLzsFile(stored);
  if (image.length !== 343_936 || sha256(image) !== EXPANDED_SHA256) {
    throw new Error('Auxiliary mecha contract expanded Battle overlay is not authenticated.');
  }
  const evidence = (startAddress, endAddress) => {
    const offset = startAddress - LOAD_ADDRESS;
    const length = endAddress - startAddress;
    return {
      sourceId: context.sourceId,
      imageSha256: EXPANDED_SHA256,
      startAddress,
      offset,
      length,
      sha256: sha256(image.subarray(offset, offset + length)),
    };
  };
  const selectorOffset = 0x800c3530 - LOAD_ADDRESS;
  // This is the authenticated table extent covering authored selectors 0..16,
  // not a claim that the native unchecked lookup enforces a 17-entry bound.
  const selectorBases = Array.from(image.subarray(selectorOffset, selectorOffset + 17));
  const contract = {
    schema: { name: 'xenogears-battle-mecha-auxiliary-contract', version: 1 },
    decoder: { ...BATTLE_MECHA_AUXILIARY_CONTRACT_DECODER },
    discNumber: context.discNumber,
    complete: true,
    source: {
      id: context.sourceId,
      bytes: value.byteLength,
      sha256: context.sha256,
      expandedBytes: image.length,
      expandedSha256: EXPANDED_SHA256,
      loadAddress: LOAD_ADDRESS,
    },
    ownership: {
      family: 'battle',
      role: 'mecha-auxiliary-animation',
      directoryOrdinal: 21,
      firstFlatIndex: disc.firstFlatIndex,
      sourceCount: 231,
      nativeFirstFileNumber: 2,
      archiveSelection: {
        directory: 0x28,
        subdirectory: 2,
        headerEntry: 42,
        headerValue: disc.firstFlatIndex,
        catalogFileNumberBase: 1,
        nativeFirstFileNumber: 2,
        archiveTableOffset: disc.firstFlatIndex - 1,
        sourceFlatIndex: 'firstFlatIndex + nativeFileNumber - 2',
        sourceIndexSha256: disc.sourceIndexSha256,
        archiveHeaderSha256: disc.archiveHeaderSha256,
        archiveHeaderRawRange: { offset: 40 * 2352 + 24, length: 122 },
      },
      ownerContext: ['current-mecha-skeleton', 'current-mecha-pose-and-tracks', 'current-mecha-scale', 'battle-animation-state'],
      observedCallersAreExhaustive: false,
    },
    loader: {
      opcode: 4,
      selectorType: 'signed-16-bit-next-word',
      variantType: 'unsigned-8-bit-command-high-byte',
      selectorBases,
      tableValueType: 'unsigned-8-bit',
      fileNumber: 'selectorBases[selector] + variant',
      nativeSelectorBoundsCheck: false,
      nativeFileNumberBoundsCheck: false,
      consumesSelectorWhenAlreadyLoaded: true,
      loadsOnlyWhenNoAuxiliaryResourceIsRetained: true,
      preservesArchiveSelection: true,
      asynchronous: true,
      changesSkeleton: false,
      releasesBoneTracks: false,
      evidence: [evidence(0x800ab1fc, 0x800ab284), evidence(0x800c3530, 0x800c3541)],
    },
    finalizer: {
      opcode: 5,
      waitsForResourceAndImageTransfers: true,
      auxiliaryMemberIndex: 1,
      bindsKeyframeTable: { rootMemberIndex: 0, animationMemberIndex: 0 },
      entersAuxiliaryAnimationScripts: false,
      replacesDefaultPose: false,
      spriteBundle: { auxiliaryMemberIndex: 0, sharedBattleEffectBundle: true },
      soundEffects: { auxiliaryMemberIndex: 1, registerOnlyIfBankIdAbsent: true, unregisterOnlyIfRegisteredByThisLoad: true },
      packedUploads: {
        auxiliaryMemberIndex: 4,
        imageBase: { xWords: 896, y: 256 },
        clutBase: { xWords: 0, y: 464 },
        imagePlacementMode: 1,
        clutPlacementMode: 1,
        destination: 'unsigned16(base + relativeOrigin)',
        usesStoredOrigin: false,
      },
      releaseOpcode: 6,
      releaseClearsRetainedResourceAndAuxiliaryKeyframeTable: true,
      releaseChangesBoneTracks: false,
      releaseStopsTimedEvents: false,
      evidence: [evidence(0x800ab284, 0x800ab45c), evidence(0x800b0060, 0x800b00d0)],
    },
    keyframes: {
      baseSelectorRange: { minimum: 0, maximum: 63 },
      auxiliarySelectorRange: { minimum: 64, maximum: 253 },
      auxiliaryIndex: 'effectiveSelector - 64',
      dynamicSelectors: [254, 255],
      dynamicSelection: {
        254: 'retain-current-contextual-keyframe-selection',
        255: {
          requiredContexts: ['battle-status-flags', 'actor-animation-flags', 'entity-status-flags', 'current-contextual-keyframe-selection'],
          orderedRules: [
            { when: '(battleStatusFlags & 4) !== 0 && (actorAnimationFlags & 256) !== 0', assignSelection: 27 },
            {
              when: '(battleStatusFlags & 2) !== 0 && (actorAnimationFlags & 128) !== 0',
              whenEntityStatusBit0Clear: { assignSelection: 6 },
              whenEntityStatusBit0Set: 'retain-selection',
            },
            { when: '(actorAnimationFlags & 1024) === 0', assignSelection: 1 },
            { otherwise: 'retain-selection' },
          ],
          afterSelection: { when: '(battleStatusFlags & 1) !== 0', orSelectionMask: 128 },
        },
        effectiveSelectorMask: 0x7f,
        suppressionFlagMask: 0x80,
      },
      absentEntriesRemainAbsent: true,
      timedEvents: {
        initialize: {
          startTick: 0,
          startEventIndex: 0,
          emptyEventList: 'disable-event-processing',
          repeating: 'loopArgument !== 0',
          loopPeriod: 'keyframe.durationTicks',
        },
        opcodeBehavior: {
          applyPose: { opcode: 0x10, action: 'retain-current-event-stream' },
          bindStream: {
            opcode: 0x11,
            action: 'initialize-selected-keyframe-events',
            loopArgument: 'next-word-high-byte',
            skipWhenContextualSuppressionFlagSet: true,
          },
          bindStreamAndPrime: { opcode: 0x12, action: 'retain-current-event-stream' },
          transition: { opcode: 0x13, action: 'disable-event-processing' },
          initializeEvents: {
            opcode: 0x18,
            action: 'initialize-selected-keyframe-events',
            loopArgument: 'signed-16-bit-next-word',
            skipWhenContextualSuppressionFlagSet: false,
            changesBoneTracks: false,
          },
          clearEvents: { opcode: 0x19, action: 'disable-event-processing', changesBoneTracks: false },
        },
      },
      movementDistance: {
        updatedByOpcodes: [0x11, 0x12],
        skipWhenContextualSuppressionFlagSet: true,
        value: 'unsigned16(abs(int32(movementDistance * (int32(actorScale * rootScaleZ) >> 12)) >> 12))',
        inputType: 'signed-16-bit',
      },
      evidence: [
        evidence(0x800af518, 0x800af678),
        evidence(0x800ab5b0, 0x800ab778),
        evidence(0x800abbcc, 0x800abc08),
        evidence(0x800ae1bc, 0x800ae220),
        evidence(0x800aeeec, 0x800aeef8),
      ],
    },
    skeleton: {
      syntheticRootIndex: 0,
      modelNodeToRuntimeBone: 'modelNodeIndex + 1',
      runtimeBoneCount: 'modelNodeCount + 1',
      directPose: {
        firstRuntimeBone: 1,
        maximumBonesVisited: 'runtimeBoneCount - 1',
        tripletOrder: 'rotation-then-translation-per-bone',
        rotationCountField: 0x0c,
        translationCountField: 0x0e,
        channelPresent: 'channel flag is clear and consumed triplets are fewer than its declared count',
        protectedTrackTag: 0xff,
        excessTripletsAreNotApplied: true,
        opcodeBehavior: {
          applyPose: {
            opcode: 0x10,
            clearTracksBeforePose: false,
            skipWhenContextualSuppressionFlagSet: false,
          },
          bindStream: {
            opcode: 0x11,
            whenKeyframeLayout: 'pose',
            clearTracksBeforePose: true,
            skipWhenContextualSuppressionFlagSet: true,
          },
          bindStreamAndPrime: {
            opcode: 0x12,
            whenKeyframeLayout: 'pose',
            clearTracksBeforePose: true,
            skipWhenContextualSuppressionFlagSet: true,
          },
        },
        preclear: {
          firstRuntimeBone: 0,
          boneCount: 'runtimeBoneCount',
          channels: ['rotation', 'translation', 'scale'],
          action: 'release-and-clear-existing-unprotected-channels',
          protectedTrackTag: 0xff,
          independentOfKeyframeChannelCounts: true,
        },
      },
      encodedTracks: {
        firstRuntimeBone: 0,
        serializedDescriptorCount: 'rotationCount + 1',
        boundDescriptorCount: 'min(rotationCount + 1, runtimeBoneCount)',
        streamBase: 'keyframeStart + 24 + (rotationCount + 1) * 6 + enabledRotationPoseBytes + enabledTranslationPoseBytes',
        enabledRotationPoseBytes: '(flags & 1) === 0 ? rotationCount * 6 : 0',
        enabledTranslationPoseBytes: '(flags & 2) === 0 ? translationCount * 6 : 0',
        streamBaseUsesFullSerializedCounts: true,
        protectedTrackTag: 0xff,
        missingChannelRepresentation: 'no track for this channel within the bound descriptor range',
        skipWhenContextualSuppressionFlagSet: true,
        preservesScaleTracks: true,
        opcodeBehavior: {
          bindStream: {
            opcode: 0x11,
            primeChannelsFromPose: false,
            missingChannel: {
              nonRootBone: 'release-and-clear-existing-unprotected-channel',
              syntheticRoot: 'retain-existing-channel',
              protectedTrack: 'retain-existing-channel',
            },
          },
          bindStreamAndPrime: {
            opcode: 0x12,
            primeChannelsFromPose: {
              firstRuntimeBone: 1,
              when: 'a channel has a stored pose triplet and a present descriptor and no protected existing track',
              missingOrProtectedChannel: 'consume-stored-pose-triplet-without-applying',
              syntheticRoot: 'retain-current-pose',
            },
            missingChannel: 'retain-existing-channel',
          },
        },
        beyondBoundDescriptorRange: 'retain-existing-channels',
        trackTag: 'unsigned-8-bit-next-word-low-byte',
        repeating: '(nextWordHighByte & 1) !== 0',
        terminalTick: 'unsigned16(repeating ? durationTicks : durationTicks - 1)',
      },
      poseTransition: {
        opcode: 0x13,
        skipWhenContextualSuppressionFlagSet: false,
        keyframeSelector: 'first-operand-low-byte',
        trackTag: 'unsigned-8-bit-first-operand-high-byte',
        firstRuntimeBone: 1,
        maximumBonesVisited: 'runtimeBoneCount - 1',
        poseTraversal: 'same-triplet-order-and-channel-counts-as-direct-pose',
        keyframeLayouts: ['pose', 'streams-and-pose'],
        usesEncodedTrackSamples: false,
        preservesScaleTracks: true,
        protectedTrackTag: 0xff,
        protectedChannel: 'consume-stored-pose-triplet-without-changing-track-or-pose',
        missingPoseOrAlreadyAtTarget: 'release-and-clear-existing-unprotected-channel',
        changedPose: 'reuse-existing-unprotected-track-or-allocate-a-track-from-current-pose',
        durationTicks: 'max(secondOperandHighByte, 1)',
        repeating: '(secondOperandLowByte & 1) !== 0',
        initialTick: 0,
        interpolation: '(commandArgument & 1) === 0 ? linear-delta : approach-target',
        rotationDelta: '((target - current + 2048) & 4095) - 2048',
        rotationApproachTarget: 'signed16(current + rotationDelta)',
        translationDelta: 'signed16(target - current)',
        translationApproachTarget: 'target',
        storedStartValues: 'signed-16-bit-current-channel-values',
      },
      trackClearing: {
        releaseTransient: {
          opcode: 0x08,
          firstRuntimeBone: 0,
          boneCount: 'runtimeBoneCount',
          channels: ['rotation', 'translation', 'scale'],
          condition: 'trackTag !== 255',
          stopsTimedEvents: true,
        },
        releaseTagged: {
          opcode: 0x09,
          firstRuntimeBone: 0,
          boneCount: 'runtimeBoneCount',
          channels: ['rotation', 'translation', 'scale'],
          condition: 'trackTag === commandArgument',
          includesProtectedTracksWhenTagIs255: true,
          stopsTimedEvents: false,
        },
        releaseBoneChannels: {
          opcodeChannels: { 10: ['rotation', 'translation', 'scale'], 13: ['rotation'], 14: ['translation'] },
          runtimeBoneIndex: 'commandArgument',
          boneOutOfRange: 'leave-tracks-unchanged',
          includesProtectedTracks: true,
          stopsTimedEvents: false,
        },
        clearPose: {
          opcode: 0x0b,
          first: 'release-all-transient-tracks-including-synthetic-root',
          then: 'zero-all-nonroot-rotation-and-translation-values-even-with-protected-tracks',
          preservesScaleValues: true,
          stopsTimedEvents: false,
        },
        ownerRelease: {
          action: 'release-transient-tracks-then-tag-255-tracks-before-freeing-skeleton',
          includesAllBonesAndChannels: true,
        },
      },
      authoredDescriptorExtentIsMinimumSkeletonSize: false,
      evidence: [
        evidence(0x8007056c, 0x800705d4),
        evidence(0x8009ec4c, 0x8009ef3c),
        evidence(0x800a1b50, 0x800a1cf4),
        evidence(0x800a1cf4, 0x800a2234),
        evidence(0x800a2434, 0x800a2704),
        evidence(0x800a2704, 0x800a2acc),
        evidence(0x800a2acc, 0x800a2bb8),
        evidence(0x800a2bb8, 0x800a2ca4),
        evidence(0x800aa0bc, 0x800aa188),
        evidence(0x800ab46c, 0x800ab58c),
        evidence(0x800ab5b0, 0x800ab778),
      ],
    },
    evidence: {
      executable: {
        sourceId: `xg:d${context.discNumber}:file-${String(disc.executableFlatIndex).padStart(6, '0')}`,
        bytes: 303_104,
        sha256: disc.executableSha256,
        archiveSelection: { address: 0x80028470, length: 68, sha256: '0051629ad10ac9949e9229ef5a64dd36ac682f668d7e2cf1ed917e57c6eff2de' },
        archiveFileIndex: { address: 0x800289d0, length: 72, sha256: '99b049e4bf615bedfd6522dfe264a703ee145ec7641c1e4dc963016307ddd123' },
        packedUploadPlacement: { address: 0x8002dde4, length: 508, sha256: '758f48b55e8638ed3f177d4aad90c94501937acd9b6f690ae2e98ca6c45e4d8e' },
      },
    },
    diagnostics: [],
  };
  validateCleanContentValue(contract, 'Battle mecha auxiliary contract');
  return contract;
}
