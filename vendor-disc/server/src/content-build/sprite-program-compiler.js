import {
  readSpriteChildDefinition,
  SPRITE_ANIMATION_TICKS_PER_SECOND,
  spriteAnimationOpcodeSize,
} from '../xeno/sprite-animation.js';
import { BATTLE_TMD_PLAYBACK, decodeBattleTmdModel } from './battle-tmd-decoder.js';
import { decodeBattleTmdTextures } from './battle-tmd-textures.js';
import { assertBattlePolygonShatterContract } from './battle-polygon-shatter-contract.js';

export const SPRITE_PROGRAM_SCHEMA_VERSION = 1;

const FIELD_NOOPS = new Set([
  0x83, 0x84, 0x88, 0x89, 0x8b, 0x8f, 0x95, 0x97,
  0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
  0xb1, 0xb2, 0xc2, 0xc3, 0xc7, 0xca, 0xcb,
  0xe3, 0xe8, 0xec, 0xf0, 0xf3, 0xf4, 0xf8, 0xf9, 0xfb,
  0xfd, 0xfe, 0xff,
]);
const BATTLE_NOOPS = new Set([
  0x83, 0x84, 0x9f, 0xb1, 0xb2, 0xc7, 0xf0, 0xf4, 0xfd, 0xfe, 0xff,
]);
const BATTLE_CONTEXTS = new Map([
  [0x88, 'battle-ballistics'],
  [0x8b, 'battle-damage-display'],
  [0x95, 'battle-actor-state'],
  [0x97, 'battle-actor-state'],
  [0x99, 'battle-camera-and-actor'],
  [0x9a, 'battle-camera-and-actor'],
  [0x9b, 'battle-camera-and-actor'],
  [0x9c, 'battle-camera-and-actor'],
  [0x9d, 'battle-camera-and-actor'],
  [0x9e, 'battle-camera-and-actor'],
  [0xca, 'battle-fader-state'],
  [0xcb, 'battle-camera-shake-state'],
  [0xe3, 'battle-target-animation'],
  [0xe8, 'battle-effect-state'],
  [0xf8, 'battle-damage-state'],
  [0xfb, 'battle-source-target-distance-and-animation-generation'],
]);
const EFFECT_CONTEXTS = new Map([
  [0x05, 'battle-effect-state'],
  [0x07, 'battle-camera-and-target'],
  [0x0e, 'actor-direction-and-trailing-data'],
  [0x17, 'actor-step-and-trailing-data'],
  [0x1c, 'battle-effect-state'],
  [0x1f, 'battle-terrain'],
  [0x20, 'battle-effect-callback'],
  [0x23, 'battle-effect-state'],
  [0x28, 'actor-scale-and-trailing-data'],
  [0x2d, 'battle-actor-transform'],
  [0x2e, 'battle-actor-target'],
  [0x31, 'global-geometry-offset'],
  [0x32, 'global-geometry-offset'],
  [0x3a, 'battle-effect-state-and-trailing-data'],
  [0x40, 'battle-effect-state-and-trailing-data'],
  [0x55, 'battle-camera-and-actor'],
  [0x56, 'battle-sound-runtime'],
  [0x64, 'battle-camera-state'],
  [0x67, 'battle-camera-convergence'],
]);
// Resident 800222bc..800223ac; the only callees are the three-member
// registration at 80022224 and the frame-header bit15 test at 8001ee68.
const BATTLE_BUNDLE_BINDING = {
  nullBundle: 'preserve-current-binding-and-placement',
  whenBundleChanges: {
    rebind: ['animations', 'frames', 'palettes'],
    preserveClutOrigin: true,
    frameDataDirty: true,
    fragmentModule: {
      ready: false,
      selection: 'selected-bundle-animation-header-bits-6-through-11',
      zeroSelection: 'preserve-requested-module',
      nonzeroSelection: 'replace-requested-module',
    },
  },
  imagePlacement: {
    refresh: 'every-non-null-selection-including-unchanged-bundle',
    embeddedPixels: { x: 768, y: 256 },
    prebackedPixels: 'actor-owned-image-origin',
  },
  currentAnimationAndInstructionStream: 'preserve',
};
const VERIFIED_EFFECTS = new Map([
  // 800B4ADC..4B10 copies cameraAt800D335C's signed halfwords to actor Q16.
  [(0xc3 << 8) | 0x10, { operation: 'battle-set-position-to-camera-target', requiredContext: 'battle-camera-state' }],
  // Battle800B4698 -> 800B6464 shifts every current packet's CLUT word.
  [(0xf9 << 8) | 0x27, { operation: 'battle-shift-sprite-palette', requiredContext: 'battle-current-sprite-packet-palettes' }],
  // Authenticated retail handlers 800b483c/4848/4828/44f0.
  [(0xc3 << 8) | 0x35, { operation: 'battle-actor-flags-3c-set', setMask: 0x08000000 }],
  [(0xc3 << 8) | 0x36, { operation: 'battle-actor-flags-3c-clear', clearMask: 0x08000000 }],
  [(0xc3 << 8) | 0x3c, { operation: 'battle-actor-flags-3c-clear', clearMask: 0x20000000 }],
  [(0xc3 << 8) | 0x3b, { operation: 'battle-actor-flags-3c-set', setMask: 0x20000000 }],
  [(0xc3 << 8) | 0x43, { operation: 'battle-actor-flags-3c-set', setMask: 0x80000000 }],
  [(0xc3 << 8) | 0x11, { operation: 'battle-sprites-disable', disabled: true }],
  [(0xc3 << 8) | 0x13, { operation: 'battle-sprites-disable', disabled: false }],
  [(0xc3 << 8) | 0x57, { operation: 'battle-mecha-rendering-set', enabled: true }],
  [(0xc3 << 8) | 0x58, { operation: 'battle-mecha-rendering-set', enabled: false }],
  [(0xec << 8) | 0x21, { operation: 'battle-set-horizontal-velocity', axis: 'z',
    argumentScale: 16, rounding: 'truncate-toward-zero', resultShiftLeft: 12 }],
  // 800b4758..478c: the same signed Q16 accumulation as EC29, on Z.
  [(0xec << 8) | 0x22, { operation: 'battle-add-horizontal-velocity', axis: 'z',
    argumentScale: 16, rounding: 'truncate-toward-zero', resultShiftLeft: 8 }],
  // 800b46f0..4724: signed byte, Q12 movement scale, Q16 accumulation.
  [(0xec << 8) | 0x29, { operation: 'battle-add-horizontal-velocity', axis: 'x',
    argumentScale: 16, rounding: 'truncate-toward-zero', resultShiftLeft: 8 }],
  [(0xf9 << 8) | 0x5c, { operation: 'battle-set-render-vector-from-data', renderFieldOffset: 0x4c }],
  [(0xf9 << 8) | 0x5b, { operation: 'battle-set-render-vector-from-data', renderFieldOffset: 0x44 }],
  // Battle800B4934 -> 800B69E4 adds three signed16 values to render scale.
  [(0xf9 << 8) | 0x5e, { operation: 'battle-add-render-vector-from-data', renderFieldOffset: 0x4c }],
  [(0xf9 << 8) | 0x3d, { operation: 'battle-cache-first-sprite-packet-texture',
    textureDestination: { x: 1008, y: 496, widthWords: 8, height: 8 },
    paletteDestination: { x: 1008, y: 494, colors: 16 } }],
  [(0xec << 8) | 0x01, { operation: 'battle-create-sprite-motion-trail',
    requiredContext: 'battle-actor-sprite-packets-and-variables' }],
  [(0xc3 << 8) | 0x02, { operation: 'battle-delete-sprite-motion-trail',
    requiredContext: 'battle-actor-sprite-packets-and-variables' }],
  [(0xec << 8) | 0x46, { operation: 'battle-load-mecha-effect-resources',
    requiredContext: 'battle-mecha-effect-resources', directory: 0x28 }],
  [(0xec << 8) | 0x47, { operation: 'battle-run-mecha-effect-command',
    requiredContext: 'battle-mecha-effect-resources-and-targets', mechaSlot: 11 }],
  [(0xc3 << 8) | 0x50, { operation: 'battle-wait-mecha-effect-signal',
    requiredContext: 'battle-mecha-effect-signals' }],
  // Retail Battle dispatch 800b3f04; handlers 800b4a1c/800b4a8c save,
  // override and restore both draw environments' background-clear fields.
  // The override flag also skips environment drawing at 800bba50..800bba98.
  [(0xc3 << 8) | 0x12, {
    operation: 'battle-environment-background-save-and-override',
    requiredContext: 'battle-environment-visibility-and-background-clear',
    overrideActive: true,
    environmentVisible: false,
    clearEnabled: true,
    color: { red: 0, green: 0, blue: 0 },
  }],
  [(0xc3 << 8) | 0x14, {
    operation: 'battle-environment-background-restore',
    requiredContext: 'battle-environment-visibility-and-background-clear',
    overrideActive: false,
    environmentVisible: true,
  }],
  [(0xc3 << 8) | 0x42, {
    operation: 'battle-actor-flags-ac-clear',
    clearMask: 0x20,
  }],
  // 800b44b8 selects the actor only when the development-kit sentinel is not -1.
  // Keep that condition explicit; the authenticated retail executable stores -1.
  [(0xc3 << 8) | 0x44, {
    operation: 'battle-development-kit-actor-select',
    requiredContext: 'battle-development-kit-inspection',
    target: 'current-actor',
    enabledWhen: 'development-kit',
  }],
  [(0xc3 << 8) | 0x45, {
    operation: 'battle-development-kit-actor-clear',
    requiredContext: 'battle-development-kit-inspection',
    enabledWhen: 'development-kit',
  }],
  [(0xc3 << 8) | 0x63, {
    operation: 'battle-apply-camera-scale',
    requiredContext: 'battle-camera-and-actor-render-state',
    cameraScaleMinimumExclusive: 512,
    clearActorFlags40: 0x1f00,
    setActorFlags40: 0x0300,
    setActorFlags3C: 0x10000000,
  }],
  [0x09, {
    operation: 'battle-reverse-movement',
  }],
  [(0xec << 8) | 0x03, {
    operation: 'battle-bind-target-to-subgroup-anchors',
    requiredContext: 'battle-source-target-subgroup-transforms',
  }],
  [(0xc3 << 8) | 0x04, {
    operation: 'battle-clear-subgroup-anchor-bindings',
    requiredContext: 'battle-source-target-subgroup-transforms',
  }],
  [(0xec << 8) | 0x0d, {
    operation: 'battle-rotate-motion-vector',
  }],
  [(0xec << 8) | 0x30, {
    operation: 'battle-select-subgroup-translation',
    requiredContext: 'sprite-subgroup-transform',
  }],
  [(0xc3 << 8) | 0x0a, {
    operation: 'battle-set-render-z-rotation-from-motion',
    requiredContext: 'battle-actor-render-transform',
    dirtyFlagMask: 0x10000000,
  }],
  // 800B4BC4 -> 800B6C98: atan2(step Z >> 8, step X >> 8), render X.
  [(0xc3 << 8) | 0x0b, {
    operation: 'battle-set-render-x-rotation-from-motion',
    requiredContext: 'battle-actor-render-transform',
    dirtyFlagMask: 0x10000000,
  }],
  [(0xc3 << 8) | 0x0c, {
    operation: 'battle-set-render-orientation-from-motion',
    requiredContext: 'battle-actor-render-transform',
    dirtyFlagMask: 0x10000000,
  }],
  [(0xc3 << 8) | 0x15, {
    // 800B4A00..4A08: LUI0x0100, then OR into actor3C at800B4C60.
    // Mode15 draw8002591C tests this bit to bypass the camera matrix.
    operation: 'battle-actor-view-space-set',
    setActorFlags3C: 0x01000000,
  }],
  // 800B49F4..49FC sets bit25. Resident800259A8..25A04 draws
  // this model at background ordering slot0xFEC instead of actor depth.
  [(0xc3 << 8) | 0x16, { operation: 'battle-actor-flags-3c-set', setMask: 0x02000000 }],
  [(0xc3 << 8) | 0x1e, {
    operation: 'battle-install-motion-vector-line-renderer',
    requiredContext: 'battle-owner-render-task',
    initialFrameId: 1,
    primitive: 'tile',
    colorCode: 0x40,
  }],
  [(0xc3 << 8) | 0x48, {
    operation: 'battle-actor-secondary-flags-set',
    setActorFlags40: 0x00000001,
  }],
  // Battle800B4328..4338 sets actor40 bit1, suppressing model packet recoloring.
  [(0xc3 << 8) | 0x4c, {
    operation: 'battle-actor-secondary-flags-set', setActorFlags40: 0x00000002,
  }],
  // Battle800B4BD8..4C00 adds a signed byte to render X, then marks it dirty.
  [(0xec << 8) | 0x49, {
    operation: 'battle-add-render-rotation', axis: 0, dirtyFlagMask: 0x10000000,
    requiredContext: 'battle-actor-render-transform',
  }],
  // 800B4C04..4C2C adds the signed argument to render rotation Y.
  [(0xec << 8) | 0x4a, {
    operation: 'battle-add-render-rotation', axis: 1, dirtyFlagMask: 0x10000000,
    requiredContext: 'battle-actor-render-transform',
  }],
  [(0xc3 << 8) | 0x5a, {
    operation: 'battle-screen-color-transition-suppression-enable',
    requiredContext: 'battle-screen-color-transition-state',
    suppressed: true,
  }],
  [(0xc3 << 8) | 0x59, {
    operation: 'battle-screen-color-transition-suppression-disable',
    requiredContext: 'battle-screen-color-transition-state',
    suppressed: false,
  }],
  [(0xc3 << 8) | 0x06, {
    operation: 'battle-camera-fit-source',
    requiredContext: 'battle-camera-and-source-actor',
  }],
  [(0xc3 << 8) | 0x08, {
    operation: 'battle-actor-render-reset',
    requiredContext: 'battle-actor-and-render-state',
    actorFlagMask: 0x00080000,
    resetSubgroupCount: 8,
  }],
  [(0xc3 << 8) | 0x0f, {
    operation: 'battle-actor-facing-reset',
    requiredContext: 'battle-actor-facing',
    clearActorFlagsAC: 0x0c,
    clearActorFlags3C: 0x18,
    direction: 0,
  }],
  [(0xc3 << 8) | 0x1c, {
    operation: 'battle-velocity-toward-target-vector',
    requiredContext: 'battle-actor-motion-and-target-vector',
  }],
  [(0xc3 << 8) | 0x2c, {
    operation: 'battle-sprite-renderer-reset',
    requiredContext: 'battle-owner-render-task',
  }],
  [(0xc3 << 8) | 0x2f, {
    operation: 'battle-fx-fragments-request',
    requiredContext: 'battle-fx-fragments-and-audio',
  }],
  [(0xc3 << 8) | 0x31, {
    operation: 'battle-set-geometry-offset',
    requiredContext: 'battle-geometry-runtime',
    x: 0xa0,
    y: 0x70,
  }],
  [(0xc3 << 8) | 0x32, {
    operation: 'battle-set-geometry-offset',
    requiredContext: 'battle-geometry-runtime',
    x: 0xa0,
    y: 0xa4,
  }],
  [(0xc3 << 8) | 0x37, {
    operation: 'battle-effect-resource-request',
    requiredContext: 'battle-resource-cd-and-vram',
    directory: 0x2c,
    fileId: 1,
  }],
  [(0xc3 << 8) | 0x41, {
    operation: 'battle-camera-fit-source-and-target',
    requiredContext: 'battle-camera-source-and-target',
  }],
  [(0xc3 << 8) | 0x53, {
    operation: 'battle-actor-motion-flags-reset',
    clearActorFlagsAC: 0x0c,
    clearActorFlags3C: 0x18,
  }],
  [(0xc3 << 8) | 0x65, {
    operation: 'battle-camera-fit-jump-mask',
    requiredContext: 'battle-camera-and-jump-animation',
  }],
  [(0xc3 << 8) | 0x66, {
    operation: 'battle-camera-gear-height-disable',
    requiredContext: 'battle-camera-global-state',
    disabled: true,
  }],
  // 800B45B8 calls resident800245D8 with the unsigned animation byte.
  // That routine selects the constructor bank (+48), retaining the owner.
  [(0xec << 8) | 0x33, {
    operation: 'battle-select-base-animation',
    requiredContext: 'battle-actor-animation-bundle',
  }],
  // 800B42DC and800B42F8 select actor/common SEDS then share800B4310.
  [(0xec << 8) | 0x4d, {
    operation: 'battle-actor-sound-stop',
    requiredContext: 'battle-sound-sequence-bank',
  }],
  [(0xec << 8) | 0x4e, {
    operation: 'battle-sound-stop',
    requiredContext: 'battle-sound-sequence-bank',
  }],
  // Battle 800b42ac reads actor+50 and two unsigned operands. Resident
  // 80039ec4 maps the selected pair; 8003b644 resolves the registered SEDS ID
  // and initializes/stops those tracks. Pool 8003b148 maps 16 tracks to voices 8..23.
  [(0xf9 << 8) | 0x52, {
    operation: 'battle-play-actor-seds-effect-on-voice-pair',
    requiredContext: 'actor-seds-registered-sound-banks-enable-and-pooled-voices',
    sequenceSelection: {
      source: 'actor-attached-seds-id',
      noOwner: 'no-sound-request',
      lookup: 'registered-seds-header-unsigned16-id-equals-requested-signed16-id',
      missingIdInNonemptyRegistry: 'preserve-tracks',
      sampleBank: 'registered-sound-bank-and-preset-context',
    },
    dispatch: {
      enabledFlagMask: 0x0800,
      disabled: 'no-sound-request',
      channelCount: 2,
      channelCountUpdate: 'after-owner-and-enable-guards-before-bank-lookup',
      timing: 'nonblocking-state-request-sequence-runs-on-sound-timer',
    },
    voicePair: {
      firstLogicalTrack: '(voicePairSelector & 254) XOR 8',
      channelCount: 2,
      normalPoolTrackCount: 16,
      normalPoolPhysicalVoiceOffset: 8,
      otherTracks: 'preserve',
      nonzeroRoot: 'replace-selected-track-playback-script-repeat-loop-and-automation-state',
      zeroRoot: 'stop-selected-track-and-release-only-its-owned-voice',
      voiceClaim: 'queue-key-off-and-reinitialization-unless-another-owner-has-higher-priority',
    },
    initialVolumeQ8: 0x6000,
    initialPanQ8: 0x4000,
    effectVolume: 'min(32767, 192 * selected-effect-volume-byte)',
    priorityClass: 0x20,
    voicePriority: 0x0200,
    initialOctaveSemitoneOffset: 60,
    inputRequirements: {
      enabledDispatch: 'nonempty-registered-seds-list',
      effectIndex: 'within-selected-registered-bank-effect-table',
      voicePairSelector: '0..15-for-normal-16-track-pool',
      invalidInput: 'unprotected-native-access-no-defined-clean-behavior',
      sequenceAndSampleDependencies: 'must-be-resolved-independently',
    },
  }],
  [(0xec << 8) | 0x34, {
    operation: 'battle-set-scaled-gravity',
    requiredContext: 'battle-actor-scale-and-frame-catch-up',
    argumentScale: 2,
    actorScaleFractionBits: 12,
    resultScale: 32,
    frameCatchUpBias: 1,
    frameCatchUpExponent: 2,
  }],
  // Battle dispatch 800708f4 selects 800b4790 for subcommand 2a.
  // It reads a signed byte and signed actor movement scale (+82), truncates
  // their product / 4096 toward zero, then writes (result << 12) to step Y.
  [(0xec << 8) | 0x2a, {
    operation: 'battle-set-scaled-vertical-step',
    requiredContext: 'battle-actor-movement-scale',
    argumentScale: 16,
    movementScaleType: 'signed16',
    movementScaleFractionBits: 12,
    rounding: 'truncate-toward-zero',
    resultShiftLeft: 12,
  }],
  // Battle 800b47c0..800b47f8 uses the same signed division as 2a,
  // then shifts by 8 and adds to the previous step with wrapping ADDU.
  [(0xec << 8) | 0x2b, {
    operation: 'battle-add-scaled-vertical-step',
    requiredContext: 'battle-actor-movement-scale-and-vertical-step',
    argumentScale: 16,
    movementScaleType: 'signed16',
    movementScaleFractionBits: 12,
    rounding: 'truncate-toward-zero',
    resultShiftLeft: 8,
    accumulation: 'add-to-current-vertical-step',
    resultType: 'signed32-wrapping',
  }],
  [(0xf9 << 8) | 0x2d, {
    operation: 'battle-set-actor-position-from-data',
    requiredContext: 'battle-actor-transform',
  }],
  [(0xf9 << 8) | 0x2e, {
    operation: 'battle-set-actor-target-from-data',
    requiredContext: 'battle-actor-target',
  }],
  [(0xc3 << 8) | 0x3f, {
    operation: 'battle-actor-flags-3c-set',
    setMask: 0x04000000,
  }],
  // Native800B4070..4138: target's displacement from its formation home
  // chooses the jump side; an undisplaced target uses the attacker's facing.
  [(0xec << 8) | 0x61, {
    operation: 'battle-jump-beside-target',
    requiredContext: 'battle-target-home-position-and-ballistics',
    offsetScale: 'actor-graphic-scale-q12',
    launchHeight: 'terrain-minus-one',
  }],
  [(0xc3 << 8) | 0x68, {
    operation: 'battle-animation-bundle-select',
    requiredContext: 'battle-actor-animation-bundles-image-placement-and-fragment-module',
    selection: { source: 'actor-animation-sign', negative: 'special', nonnegative: 'default' },
    savedSelection: 'update-to-requested-bundle-even-if-null',
    binding: BATTLE_BUNDLE_BINDING,
  }],
  [(0xc3 << 8) | 0x69, {
    operation: 'battle-animation-bundle-select',
    requiredContext: 'battle-actor-animation-bundles-image-placement-and-fragment-module',
    selection: { source: 'saved-animation-bundle-selection' },
    savedSelection: 'preserve',
    binding: BATTLE_BUNDLE_BINDING,
  }],
]);
const OPERATIONS = new Map([
  [0x80, 'select-default-animation'],
  [0x81, 'end'],
  [0x82, 'loop'],
  [0x85, 'return'],
  [0x86, 'wait-for-upward-motion'],
  [0x87, 'wait-for-terrain-bound'],
  [0x89, 'initialize-target-jump'],
  [0x8a, 'stop-horizontal-motion'],
  [0x8c, 'face-target'],
  [0x8d, 'install-model-texture-page'],
  [0x8e, 'end'],
  [0x8f, 'end'],
  [0x90, 'select-animation-bundle'],
  [0x91, 'disable-raw-texture'],
  [0x92, 'enable-raw-texture'],
  [0x93, 'copy-owner-render-state'],
  [0x94, 'copy-owner-model-direction'],
  [0x96, 'cleanup-owner-sprite-callbacks'],
  [0x98, 'wait-for-linked-animation'],
  [0xa0, 'set-horizontal-speed'],
  [0xa1, 'set-vertical-step'],
  [0xa2, 'set-actor-byte-state'],
  [0xa3, 'set-gravity'],
  [0xa4, 'start-target-animation'],
  [0xa5, 'add-horizontal-speed'],
  [0xa6, 'add-vertical-step'],
  [0xa7, 'frame-delay'],
  [0xa8, 'add-direction'],
  [0xa9, 'add-position-x'],
  [0xaa, 'add-position-y'],
  [0xab, 'add-position-z'],
  [0xac, 'random-direction-displacement'],
  [0xad, 'set-directional-state'],
  [0xb0, 'play-actor-sound'],
  [0xb3, 'set-direction-frame-index'],
  [0xb4, 'push-loop-count'],
  [0xb5, 'set-graphic-scale'],
  [0xb8, 'reserve-animation-stack'],
  [0xb9, 'play-actor-sound'],
  [0xba, 'set-transparency-mode'],
  [0xbb, 'add-actor-field-30'],
  [0xbc, 'set-position-anchor'],
  [0xbd, 'select-auxiliary-animation'],
  [0xbe, 'show-explicit-frame'],
  [0xbf, 'set-frame-extent-x'],
  [0xc0, 'random-position-x'],
  [0xc1, 'random-position-z'],
  [0xc2, 'initialize-scaled-target-jump'],
  [0xc3, 'battle-effect'],
  [0xc4, 'random-movement'],
  [0xc5, 'advance-motion'],
  [0xc6, 'set-child-state-byte'],
  [0xc8, 'apply-variable-operation'],
  [0xc9, 'set-child-state'],
  [0xcc, 'set-secondary-pointer'],
  [0xcd, 'apply-rotation-x'],
  [0xce, 'apply-rotation-y'],
  [0xcf, 'apply-rotation-z'],
  [0xd4, 'jump'],
  [0xe0, 'create-child'],
  [0xe1, 'jump'],
  [0xe2, 'call'],
  [0xe4, 'counted-loop'],
  [0xe5, 'assign-random-variable'],
  [0xe6, 'assign-variable'],
  [0xe7, 'add-graphic-scale'],
  [0xe9, 'add-scale-x'],
  [0xea, 'add-scale-y'],
  [0xeb, 'add-scale-z'],
  [0xec, 'battle-effect'],
  [0xed, 'set-position-x'],
  [0xee, 'set-position-y-from-ground'],
  [0xef, 'set-position-z'],
  [0xf1, 'set-color'],
  [0xf2, 'add-color'],
  [0xf5, 'replace-model'],
  [0xf6, 'replace-model'],
  [0xf7, 'replace-model'],
  [0xf9, 'battle-effect'],
  [0xfa, 'branch-on-variable'],
  [0xfc, 'upload-vram-resource'],
]);

function asBytes(value) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Sprite program compiler requires parsed animation bytes.');
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function i16(bytes, offset) {
  const value = u16(bytes, offset);
  return value > 0x7fff ? value - 0x10000 : value;
}

function u24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function i8(value) {
  return value > 0x7f ? value - 0x100 : value;
}

function diagnostic(code, message, details = {}) {
  return { code, message, details };
}

function context(code, ...requiredContexts) {
  return { code, requiredContexts };
}

function verifiedBattleEffect(opcode, runtimeContext, operands) {
  if (
    runtimeContext !== 'battle'
    || (opcode !== 0xc3 && opcode !== 0xec && opcode !== 0xf9)
  ) {
    return null;
  }
  const subcommand = operands[0]?.value;
  const definition = VERIFIED_EFFECTS.get((opcode << 8) | subcommand)
    ?? VERIFIED_EFFECTS.get(subcommand);
  if (!definition) return null;
  const { operation, requiredContext = null, ...parameters } = definition;
  if (opcode === 0xec && (subcommand === 0x4d || subcommand === 0x4e)) {
    parameters.soundId = operands.find(({ name }) => name === 'argument')?.value ?? null;
  }
  if (opcode === 0xec && subcommand === 0x33) {
    parameters.animationId = operands.find(({ name }) => name === 'argument').value;
  }
  if (opcode === 0xec && subcommand === 0x34) {
    parameters.encodedGravityFactor = operands.find(({ name }) => name === 'argument')?.value ?? null;
  }
  if (opcode === 0xec && (subcommand === 0x2a || subcommand === 0x2b)) {
    parameters.encodedVerticalStep = operands.find(({ name }) => name === 'argument')?.value ?? null;
  }
  if (opcode === 0xf9 && subcommand === 0x52) {
    parameters.effectIndex = operands.find(({ name }) => name === 'effectIndex').value;
    parameters.voicePairSelector = operands.find(({ name }) => name === 'voicePairSelector').value;
    const firstTrack = (parameters.voicePairSelector & 0xfe) ^ 8;
    parameters.logicalTracks = [firstTrack, firstTrack + 1];
  }
  const argument = operands.find(({ name }) => name === 'argument')?.value;
  if (opcode === 0xf9 && subcommand === 0x27) {
    parameters.xUnits = argument & 255;
    parameters.y = argument >>> 8;
  }
  if (opcode === 0xec && [0x49, 0x4a].includes(subcommand)) parameters.angleUnits = i8(argument);
  if (opcode === 0xec && [0x21, 0x22, 0x29].includes(subcommand)) parameters.encodedHorizontalStep = i8(argument);
  if (opcode === 0xec && subcommand === 0x01) parameters.variableSelector = argument;
  if (opcode === 0xec && subcommand === 0x46) parameters.resourceIndex = argument;
  if (opcode === 0xec && subcommand === 0x47) parameters.command = argument;
  if (opcode === 0xec && subcommand === 0x03) {
    parameters.sourceSubgroup = argument & 0x0f;
    parameters.targetSubgroup = argument >>> 4;
  }
  if (opcode === 0xec && subcommand === 0x0d) {
    parameters.angleStep = argument;
    parameters.angleUnits = argument * 16;
  }
  if (opcode === 0xec && subcommand === 0x30) {
    parameters.subgroupIndex = argument;
  }
  return { operation, requiredContext, parameters };
}

function isNoop(opcode, runtimeContext) {
  return runtimeContext === 'field' ? FIELD_NOOPS.has(opcode) : BATTLE_NOOPS.has(opcode);
}

function operationFor(opcode, runtimeContext) {
  if (opcode < 0x10) return 'show-next-frame';
  if (opcode < 0x20) return 'show-next-direction-frame';
  if (opcode < 0x30) return 'show-previous-frame';
  if (opcode < 0x40) return 'hold-frame';
  if (opcode < 0x80) return 'show-compact-delay-frame';
  if (isNoop(opcode, runtimeContext)) return 'noop';
  if (runtimeContext === 'battle' && opcode === 0xca) return 'create-battle-fader';
  if (runtimeContext === 'battle' && opcode === 0xcb) return 'install-battle-camera-shake';
  if (runtimeContext === 'battle' && opcode === 0xfb) return 'install-battle-distance-watcher';
  if (runtimeContext === 'battle' && opcode === 0xf8) return 'branch-on-battle-condition';
  if (runtimeContext === 'battle' && opcode === 0xe3) return 'start-target-animation-from-header';
  if (runtimeContext === 'battle' && BATTLE_CONTEXTS.has(opcode)) return 'battle-context-operation';
  if (
    (runtimeContext === 'field' && opcode === 0x8c)
    || (runtimeContext === 'battle' && (opcode === 0x8d || opcode === 0x94))
  ) {
    return 'unsupported';
  }
  if (opcode >= 0xd0 && opcode <= 0xdf && opcode !== 0xd4) return 'variable-operation';
  return OPERATIONS.get(opcode) ?? 'unsupported';
}

function operandsFor(bytes, offset, opcode, size, runtimeContext) {
  if (opcode < 0x40) return [{ name: 'durationTicks', type: 'ticks', value: (opcode & 0x0f) + 1 }];
  if (opcode < 0x80 || size === 1) return [];
  if ([0xa0, 0xa1, 0xa3, 0xa5, 0xa6, 0xa8, 0xa9, 0xaa, 0xab, 0xb5, 0xbb].includes(opcode)) {
    return [{ name: 'value', type: 'signed-byte', value: i8(bytes[offset + 1]) }];
  }
  if (opcode === 0xbe) {
    const packed = u16(bytes, offset + 1);
    return [
      {
        name: 'frameReference',
        type: 'active-sprite-frame-bank-reference',
        value: packed & 0x01ff,
        rawValue: packed,
        sourceOffset: offset + 1,
      },
      { name: 'flipX', type: 'boolean', value: (packed & 0x0200) !== 0 },
      { name: 'flipY', type: 'boolean', value: (packed & 0x0400) !== 0 },
      { name: 'durationTicks', type: 'ticks', value: ((packed >> 11) & 0x0f) + 1 },
    ];
  }
  if (opcode === 0xcc) {
    const relativeOffset = i16(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-instruction-offset', value: relativeOffset },
      { name: 'targetOffset', type: 'instruction-offset', value: offset + relativeOffset },
    ];
  }
  if (opcode === 0xca || opcode === 0xcb) {
    const relativeOffset = i16(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-data-offset', value: relativeOffset },
      { name: 'dataOffset', type: 'data-offset', value: offset + 1 + relativeOffset },
    ];
  }
  if ([0xd4, 0xe1, 0xe2, 0xe4].includes(opcode)) {
    const relativeOffset = i16(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-instruction-offset', value: relativeOffset },
      { name: 'targetOffset', type: 'instruction-offset', value: offset + relativeOffset },
    ];
  }
  if (opcode === 0xe0) {
    const relativeOffset = i16(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-child-header-offset', value: relativeOffset },
      { name: 'headerOffset', type: 'child-header-offset', value: offset + 1 + relativeOffset },
    ];
  }
  if (runtimeContext === 'battle' && opcode === 0xe3) {
    const relativeOffset = i16(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-animation-header-offset', value: relativeOffset },
      { name: 'headerOffset', type: 'animation-header-offset', value: offset + relativeOffset },
    ];
  }
  if ([0xe7, 0xe9, 0xea, 0xeb, 0xed, 0xee, 0xef].includes(opcode)) {
    return [{ name: 'value', type: 'signed-halfword', value: i16(bytes, offset + 1) }];
  }
  if (opcode >= 0xcd && opcode <= 0xcf) {
    const packed = u16(bytes, offset + 1);
    return [
      { name: 'subgroup', type: 'sprite-subgroup-id', value: (packed >> 9) & 7 },
      { name: 'setValue', type: 'boolean', value: (packed & 0x1000) !== 0 },
      { name: 'angle', type: 'angle-units', value: (packed & 0x01ff) * 8 },
    ];
  }
  if (opcode === 0xf1) {
    return [
      { name: 'red', type: 'byte', value: bytes[offset + 1] },
      { name: 'green', type: 'byte', value: bytes[offset + 2] },
      { name: 'blue', type: 'byte', value: bytes[offset + 3] },
    ];
  }
  if (opcode === 0xf2) {
    return [
      { name: 'redDelta', type: 'signed-byte', value: i8(bytes[offset + 1]) },
      { name: 'greenDelta', type: 'signed-byte', value: i8(bytes[offset + 2]) },
      { name: 'blueDelta', type: 'signed-byte', value: i8(bytes[offset + 3]) },
    ];
  }
  if (opcode === 0xfa) {
    const relativeOffset = i16(bytes, offset + 2);
    return [
      { name: 'variableSelector', type: 'animation-variable-selector', value: bytes[offset + 1] },
      { name: 'relativeOffset', type: 'relative-instruction-offset', value: relativeOffset },
      { name: 'targetOffset', type: 'instruction-offset', value: offset + relativeOffset },
    ];
  }
  if (runtimeContext === 'battle' && opcode === 0xf8) {
    const relativeOffset = i16(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-instruction-offset', value: relativeOffset },
      { name: 'targetOffset', type: 'instruction-offset', value: offset + relativeOffset },
      // This is a predicate selector, not a damage value: native selector4
      // accepts damage4 or7, and selectors7..9 read other Battle state.
      { name: 'conditionSelector', type: 'battle-condition-selector', value: bytes[offset + 3] & 0x7f },
      { name: 'invert', type: 'boolean', value: (bytes[offset + 3] & 0x80) !== 0 },
    ];
  }
  if (opcode === 0xfb) {
    const relativeOffset = i16(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-instruction-offset', value: relativeOffset },
      { name: 'targetOffset', type: 'instruction-offset', value: offset + relativeOffset },
      { name: 'distanceThreshold', type: 'battle-distance', value: bytes[offset + 3] << 1 },
    ];
  }
  if ((opcode >= 0xf5 && opcode <= 0xf7) || opcode === 0xfc) {
    const relativeOffset = u24(bytes, offset + 1);
    return [
      { name: 'relativeOffset', type: 'relative-resource-offset', value: relativeOffset },
      { name: 'targetOffset', type: 'resource-offset', value: offset + 1 + relativeOffset },
    ];
  }
  if (opcode === 0xc3 || opcode === 0xec || opcode === 0xf9) {
    const result = [{ name: 'subcommand', type: 'battle-effect-command', value: bytes[offset + 1] }];
    if (opcode === 0xf9 && bytes[offset + 1] === 0x52) {
      result.push(
        { name: 'effectIndex', type: 'byte', value: bytes[offset + 2] },
        { name: 'voicePairSelector', type: 'byte', value: bytes[offset + 3] },
      );
      return result;
    }
    if (opcode === 0xf9 && [0x19, 0x1d, 0x2d, 0x2e].includes(bytes[offset + 1])) {
      const relativeOffset = i16(bytes, offset + 2);
      result.push(
        { name: 'relativeOffset', type: 'relative-data-offset', value: relativeOffset },
        { name: 'dataOffset', type: 'data-offset', value: offset + 2 + relativeOffset },
      );
      return result;
    }
    if (size === 3) {
      const signedArgument = opcode === 0xec
        && [0x0d, 0x2a, 0x2b, 0x34, 0x61].includes(bytes[offset + 1]);
      result.push({
        name: 'argument',
        type: signedArgument ? 'signed-byte' : 'byte',
        value: signedArgument
          ? i8(bytes[offset + 2])
          : bytes[offset + 2],
      });
    }
    if (size === 4) result.push({ name: 'argument', type: 'halfword', value: u16(bytes, offset + 2) });
    return result;
  }
  if (size === 2) return [{ name: 'value', type: 'byte', value: bytes[offset + 1] }];
  if (size === 3) return [{ name: 'value', type: 'halfword', value: u16(bytes, offset + 1) }];
  return [{ name: 'value', type: 'three-byte-value', value: u24(bytes, offset + 1) }];
}

function contextRequest(opcode, runtimeContext, operands) {
  if (isNoop(opcode, runtimeContext)) return null;
  if (opcode >= 0x40 && opcode < 0x80) {
    return context('SPRITE_COMPACT_DELAY_CONTEXT_REQUIRED', 'incoming-delay-register');
  }
  if (opcode === 0xbe) {
    return context('SPRITE_FRAME_BANK_CONTEXT_REQUIRED', 'active-sprite-frame-bank');
  }
  if (runtimeContext === 'battle' && BATTLE_CONTEXTS.has(opcode)) {
    return context('BATTLE_SPRITE_CONTEXT_REQUIRED', BATTLE_CONTEXTS.get(opcode));
  }
  const contexts = new Map([
    [0x90, 'actor-animation-bundles'],
    [0x93, 'owner-sprite-render-state'],
    [0x96, 'owner-task-and-sprite-callback-lists'],
    [0x98, 'linked-actor-animation'],
    [0xa4, 'target-actor-animation-bundle'],
    [0xac, 'retail-rng'],
    [0xbc, 'actor-anchor-and-transform'],
    [0xbd, 'auxiliary-animation-bundle'],
    [0xc0, 'retail-rng'],
    [0xc1, 'retail-rng'],
    [0xc4, 'retail-rng'],
    [0xc5, 'actor-motion-collision-and-terrain'],
    [0xc8, 'animation-variable-store'],
    [0xe0, 'child-actor-and-animation-resource'],
    [0xe5, 'animation-variable-store-and-retail-rng'],
    [0xe6, 'animation-variable-store'],
  ]);
  if (opcode === 0x86) {
    return context(
      'SPRITE_VERTICAL_MOVEMENT_CONTEXT_REQUIRED',
      'actor-motion',
      'actor-motion-and-gravity',
    );
  }
  if (opcode === 0x87) {
    return context(
      'SPRITE_VERTICAL_BOUND_CONTEXT_REQUIRED',
      'actor-position-and-terrain-bound',
      'actor-motion-and-terrain',
    );
  }
  if (runtimeContext === 'battle' && (opcode === 0x89 || opcode === 0xc2)) {
    return context('BATTLE_JUMP_CONTEXT_REQUIRED', 'battle-target-and-terrain');
  }
  if (runtimeContext === 'battle' && opcode === 0x8c) {
    return context('BATTLE_TARGET_DIRECTION_CONTEXT_REQUIRED', 'actor-and-target-direction');
  }
  if (runtimeContext === 'field' && opcode === 0x8d) {
    return context('SPRITE_TPAGE_OVERRIDE_CONTEXT_REQUIRED', 'actor-vram-and-model-renderer');
  }
  if (runtimeContext === 'field' && opcode === 0x94) {
    return context(
      'SPRITE_OWNER_ROTATION_CONTEXT_REQUIRED',
      'actor-type-owner-direction-and-render-object',
    );
  }
  if (opcode === 0xa7 && ((operands[0]?.value ?? 0) & 0x80) !== 0) {
    return context('GLOBAL_SPRITE_DELAY_CONTEXT_REQUIRED', 'global-sprite-delay');
  }
  if (opcode >= 0xcd && opcode <= 0xcf && operands[0]?.value !== 0) {
    return context('SPRITE_SUBGROUP_TRANSFORM_CONTEXT_REQUIRED', 'sprite-subgroup-transform');
  }
  if (opcode >= 0xd0 && opcode <= 0xdf && opcode !== 0xd4) {
    return context('SPRITE_VARIABLE_CONTEXT_REQUIRED', 'animation-variable-store');
  }
  if (opcode === 0xc3 || opcode === 0xec || opcode === 0xf9) {
    const subcommand = operands[0]?.value;
    const verified = verifiedBattleEffect(opcode, runtimeContext, operands);
    if (verified?.requiredContext) {
      return {
        code: 'BATTLE_SPRITE_EFFECT_CONTEXT_REQUIRED',
        requiredContexts: [verified.requiredContext],
        operation: verified.operation,
        parameters: verified.parameters,
      };
    }
    const requiredContext = EFFECT_CONTEXTS.get(subcommand);
    return requiredContext
      ? context('BATTLE_SPRITE_EFFECT_CONTEXT_REQUIRED', requiredContext)
      : null;
  }
  if (opcode >= 0xf5 && opcode <= 0xf7) {
    return context('SPRITE_MODEL_RESOURCE_CONTEXT_REQUIRED', 'model-resource-and-render-object');
  }
  if (runtimeContext === 'battle' && opcode === 0xf3) {
    return context('BATTLE_MODEL_RESOURCE_CONTEXT_REQUIRED', 'battle-actor-model-and-render-state');
  }
  if (opcode === 0xfa) {
    return context('SPRITE_VARIABLE_CONTEXT_REQUIRED', 'animation-variable-store');
  }
  if (opcode === 0xfc) {
    return context('SPRITE_VRAM_RESOURCE_CONTEXT_REQUIRED', 'actor-vram-and-resource');
  }
  const requiredContext = contexts.get(opcode);
  if (!requiredContext) return null;
  return context('SPRITE_EXECUTION_CONTEXT_REQUIRED', requiredContext);
}

function controlFlow(offset, opcode, size, operation, operands, contextRequestValue, blocked) {
  const nextOffset = offset + size;
  const targetOffset = operands.find(({ name }) => name === 'targetOffset')?.value;
  if (blocked) return { kind: 'blocked', nextOffset: null, targetOffsets: [] };
  if (operation === 'branch-on-variable' || operation === 'branch-on-battle-condition') {
    return { kind: 'runtime-branch', nextOffset, targetOffsets: [targetOffset] };
  }
  if (operation === 'install-battle-distance-watcher') {
    return { kind: 'async-branch', nextOffset, targetOffsets: [targetOffset] };
  }
  if (contextRequestValue) {
    return {
      kind: 'runtime-context',
      nextOffset,
      targetOffsets: [],
    };
  }
  if (operation === 'jump') return { kind: 'jump', nextOffset: null, targetOffsets: [targetOffset] };
  if (operation === 'call') return { kind: 'call', nextOffset, targetOffsets: [targetOffset] };
  if (operation === 'counted-loop') return { kind: 'branch', nextOffset, targetOffsets: [targetOffset] };
  if (['select-default-animation', 'end', 'loop', 'return'].includes(operation)) {
    return { kind: 'terminate', nextOffset: null, targetOffsets: [] };
  }
  return { kind: 'fallthrough', nextOffset, targetOffsets: [] };
}

function directionsFor(directionType, directionTableOffsets) {
  const count = directionType === 0 ? 1 : directionType === 1 ? 4 : directionType === 2 ? 8 : 0;
  return Array.from({ length: count }, (_, direction) => {
    let tableIndex = direction;
    let mirrored = false;
    if (directionType === 1 && direction === 3) {
      tableIndex = 1;
      mirrored = true;
    } else if (directionType === 2 && direction > 4) {
      tableIndex = (direction - 5) ^ 3;
      mirrored = true;
    }
    const sourceOffset = directionTableOffsets[tableIndex];
    return {
      direction,
      tableIndex,
      mirrored,
      tableId: `direction-table-${sourceOffset}`,
    };
  });
}

function directionTable(bytes, sourceOffset) {
  // Retail masks the lookup index to six bits and stores no table length. The
  // window may intentionally share bytes with another structure.
  const entryCount = Math.min(0x40, Math.floor((bytes.length - sourceOffset) / 2));
  return {
    id: `direction-table-${sourceOffset}`,
    kind: 'masked-address-window',
    sourceOffset,
    indexMask: 0x3f,
    addressableByteLength: entryCount * 2,
    entries: Array.from({ length: entryCount }, (_, index) => {
      const value = u16(bytes, sourceOffset + index * 2);
      return { index, frameId: value & 0x01ff, flipX: (value & 0x0200) !== 0 };
    }),
  };
}

function cleanChild(child) {
  const creationMode = child.rawCreationMode === 3
    ? { kind: 'inherit-parent' }
    : child.creationMode;
  return {
    id: `child-${child.headerOffset}`,
    opcodeOffsets: [child.opcodeOffset],
    headerOffset: child.headerOffset,
    header: child.header,
    rawCreationMode: child.rawCreationMode,
    creationMode,
    runtimeMode: child.rawCreationMode === 3 ? null : child.runtimeMode,
    sequenceOffset: child.sequenceOffset,
    directionType: child.animationSet.animations[0].directionType,
    gravityFactor: child.animationSet.animations[0].gravityFactor,
    directionTableIds: child.animationSet.animations[0].directionTableOffsets.map((offset) => (
      `direction-table-${offset}`
    )),
  };
}

function targetAnimationReference(bytes, sourceOffset) {
  // E3 installs a header from the caller's bytecode on its existing target.
  // Unlike E0, the displacement is based at the opcode, and no child is made.
  if (sourceOffset < 0 || sourceOffset + 6 > bytes.length) {
    throw new Error('Battle target-animation header is outside the animation entry.');
  }
  const flags = u16(bytes, sourceOffset), directionType = flags & 3;
  const pointerCount = [1, 3, 5][directionType];
  if (!pointerCount || sourceOffset + 4 + pointerCount * 2 > bytes.length) {
    throw new Error('Battle target-animation direction header is invalid or truncated.');
  }
  function relativePointer(fieldOffset, minimumBytes) {
    const value = fieldOffset + u16(bytes, fieldOffset);
    if (value + minimumBytes > bytes.length) {
      throw new Error('Battle target-animation sequence or direction pointer is outside the animation entry.');
    }
    return value;
  }
  const sequenceOffset = relativePointer(sourceOffset + 2, 1);
  const directionTableOffsets = Array.from({ length: pointerCount }, (_, index) => (
    relativePointer(sourceOffset + 4 + index * 2, 2)
  ));
  return {
    id: `target-animation-${sourceOffset}`, kind: 'target-animation', sourceOffset,
    byteLength: 4 + pointerCount * 2, animationId: 63, flags, sequenceOffset,
    directionType, gravityFactor: ((flags >> 2) & 0x3f) << 26 >> 26,
    directions: directionsFor(directionType, directionTableOffsets), directionTableOffsets,
  };
}

function battleDataReference(bytes, offset, opcode, operands) {
  if (opcode === 0xf9 && [0x5b, 0x5c, 0x5e].includes(operands[0]?.value)) {
    const sourceOffset = offset + 2 + i16(bytes, offset + 2);
    const valid = sourceOffset >= 0 && sourceOffset + 6 <= bytes.length;
    return { id: `render-vector-${sourceOffset}`, kind: 'render-vector', sourceOffset, byteLength: 6,
      x: valid ? i16(bytes, sourceOffset) : null,
      y: valid ? i16(bytes, sourceOffset + 2) : null,
      z: valid ? i16(bytes, sourceOffset + 4) : null };
  }
  if (opcode === 0xf9 && operands[0]?.value === 0x1d) {
    const sourceOffset = offset + 2 + i16(bytes, offset + 2);
    const valid = sourceOffset >= 0 && sourceOffset + 6 <= bytes.length;
    return {
      id: `polygon-shatter-${sourceOffset}`, kind: 'polygon-shatter', sourceOffset, byteLength: 6,
      gravityBase: valid ? (i8(bytes[sourceOffset + 1]) << 3) | bytes[sourceOffset] : null,
      baseSpeed: valid ? bytes[sourceOffset + 2] : null,
      speedSpread: valid ? bytes[sourceOffset + 3] : null,
      spinSpread: valid ? bytes[sourceOffset + 4] << 4 : null,
      lifetimeUpdates: valid ? bytes[sourceOffset + 5] << 2 : null,
    };
  }
  if (opcode === 0xf9 && (operands[0]?.value === 0x2d || operands[0]?.value === 0x2e)) {
    const relativeOffset = i16(bytes, offset + 2);
    const sourceOffset = offset + 2 + relativeOffset;
    const kind = operands[0].value === 0x2d ? 'actor-position' : 'actor-target';
    return {
      id: `${kind}-${sourceOffset}`,
      kind,
      sourceOffset,
      byteLength: 6,
      coordinateSpace: 'battle-source-native',
      x: sourceOffset >= 0 && sourceOffset + 6 <= bytes.length ? i16(bytes, sourceOffset) : null,
      y: sourceOffset >= 0 && sourceOffset + 6 <= bytes.length ? i16(bytes, sourceOffset + 2) : null,
      z: sourceOffset >= 0 && sourceOffset + 6 <= bytes.length ? i16(bytes, sourceOffset + 4) : null,
    };
  }
  if (opcode === 0xca) {
    const relativeOffset = i16(bytes, offset + 1);
    const sourceOffset = offset + 1 + relativeOffset;
    const valid = sourceOffset >= 0 && sourceOffset + 5 <= bytes.length;
    const encodedAbe = valid ? bytes[sourceOffset + 4] : 0;
    return {
      id: `battle-fader-${sourceOffset}`,
      kind: 'battle-fader',
      sourceOffset,
      byteLength: 5,
      targetColor: valid ? {
        red: bytes[sourceOffset],
        green: bytes[sourceOffset + 1],
        blue: bytes[sourceOffset + 2],
      } : null,
      durationTicks: valid ? (bytes[sourceOffset + 3] >>> 1) * 2 : null,
      sourceDurationLowBitIgnored: valid ? bytes[sourceOffset + 3] & 1 : null,
      texturePageAbe: !valid ? null : encodedAbe === 0
        ? { kind: 'inherit-active-or-default', defaultValue: 1 }
        : { kind: 'immediate', value: i8((encodedAbe - 1) & 0xff) },
    };
  }
  if (opcode === 0xcb) {
    const relativeOffset = i16(bytes, offset + 1);
    const sourceOffset = offset + 1 + relativeOffset;
    const valid = sourceOffset >= 0 && sourceOffset + 4 <= bytes.length;
    return {
      id: `battle-camera-shake-${sourceOffset}`,
      kind: 'battle-camera-shake',
      sourceOffset,
      byteLength: 4,
      coordinateSpace: 'battle-render-offset',
      shakeX: valid ? bytes[sourceOffset] : null,
      shakeY: valid ? bytes[sourceOffset + 1] : null,
      shakeZ: valid ? bytes[sourceOffset + 2] : null,
      durationTicks: valid ? bytes[sourceOffset + 3] * 2 : null,
    };
  }
  return null;
}

export function compileSpriteAnimationProgram(animationSet, {
  runtimeContext, tmdVram = null, polygonShatterContract = null,
} = {}) {
  if (!animationSet || !Array.isArray(animationSet.animations)) {
    throw new TypeError('Sprite program compiler requires a parsed animation set.');
  }
  if (runtimeContext !== 'field' && runtimeContext !== 'battle') {
    throw new TypeError('Sprite program runtime context must be field or battle.');
  }
  if (polygonShatterContract !== null) assertBattlePolygonShatterContract(polygonShatterContract);
  const bytes = asBytes(animationSet.buffer);
  // Bundle registration selects the requested module from these authored bits.
  // Its loaded state at a later callback is a runtime input, not source identity.
  const declaredFragmentModuleId = bytes.length >= 2 ? (u16(bytes, 0) >>> 6) & 63 : null;
  const boundShatter = polygonShatterContract !== null && declaredFragmentModuleId === 3;
  const roots = animationSet.animations.map((animation) => ({
    animationId: animation.id,
    offset: animation.offset,
    valid: animation.valid,
    flags: animation.flags ?? null,
    directionType: animation.directionType ?? null,
    gravityFactor: animation.gravityFactor ?? null,
    sequenceOffset: animation.sequenceOffset,
    directions: animation.valid
      ? directionsFor(animation.directionType, animation.directionTableOffsets)
      : [],
    diagnostics: animation.diagnostics.map((value) => ({ ...value })),
  }));
  const directionOffsets = new Set(animationSet.animations.flatMap((animation) => (
    animation.valid ? animation.directionTableOffsets : []
  )));
  const instructions = new Map();
  const children = new Map();
  const secondaryEntries = new Map();
  const resourceReferences = new Map();
  const dataReferences = new Map();
  const attachments = [];
  const diagnostics = [];
  const requiredContexts = new Set();
  let usesPolygonShatter = false;
  let usesBattleModels = false;
  const queue = roots.filter(({ valid }) => valid).map(({ sequenceOffset }) => sequenceOffset);

  function addDiagnostic(code, message, details) {
    diagnostics.push(diagnostic(code, message, details));
  }

  while (queue.length > 0) {
    let offset = queue.pop();
    while (Number.isInteger(offset) && offset >= 0 && offset < bytes.length && !instructions.has(offset)) {
      const opcode = bytes[offset];
      const size = spriteAnimationOpcodeSize(opcode);
      if (offset + size > bytes.length) {
        addDiagnostic('SPRITE_PROGRAM_INSTRUCTION_TRUNCATED', 'Sprite instruction crosses the animation entry.', {
          offset, opcode, size, availableBytes: bytes.length - offset,
        });
        break;
      }
      const battleModel = runtimeContext === 'battle' && opcode === 0xf3;
      if (battleModel) {
        usesBattleModels = true;
        BATTLE_TMD_PLAYBACK.requiredContexts.forEach(value => requiredContexts.add(value));
      }
      // Retail 800c1aa4..800c1ac4 sign-extends the third byte and bases the
      // displacement at instruction+1. Zero releases the active model.
      const modelRelativeOffset = battleModel
        ? (u24(bytes, offset + 1) << 8) >> 8
        : null;
      const operands = battleModel ? [
        { name: 'relativeOffset', type: 'signed-relative-resource-offset', value: modelRelativeOffset },
        { name: 'targetOffset', type: 'resource-offset', value: modelRelativeOffset === 0 ? null : offset + 1 + modelRelativeOffset },
      ] : operandsFor(bytes, offset, opcode, size, runtimeContext);
      const verifiedEffect = verifiedBattleEffect(opcode, runtimeContext, operands);
      // Battle800B4CF0 calls the loaded module's801FC6FC entry. Module5
      // installs the scrolling sixteen-copy sprite strip; other modules do
      // not acquire that meaning from a shared native entry address.
      const scrollingStrip = runtimeContext === 'battle' && opcode === 0xc3 && operands[0]?.value === 0x25
        && declaredFragmentModuleId === 5;
      const tiledStrip = runtimeContext === 'battle' && opcode === 0xc3 && operands[0]?.value === 0x24
        && declaredFragmentModuleId === 4;
      const sineStrip = runtimeContext === 'battle' && opcode === 0xf9 && operands[0]?.value === 0x19
        && declaredFragmentModuleId === 2;
      let sineParameters = null;
      if (sineStrip) {
        const start = operands.find(row => row.name === 'dataOffset').value;
        if (start < 0 || start + 6 > bytes.length) throw new Error('Battle sinusoidal strip parameters exceed their source.');
        sineParameters = { moduleId: 2, phase: bytes[start] * 16, amplitude: bytes[start + 1],
          amplitudeStepQ8: i8(bytes[start + 2]) * 8, phaseStep: bytes[start + 3] * 8,
          phaseStepDeltaQ8: i8(bytes[start + 4]) * 8, phasePerTick: bytes[start + 5] };
      }
      const polygonShatter = runtimeContext === 'battle' && opcode === 0xf9 && operands[0]?.value === 0x1d;
      if (polygonShatter) usesPolygonShatter = true;
      const operation = battleModel
        ? modelRelativeOffset === 0 ? 'battle-model-clear' : 'battle-model-load'
        : scrollingStrip ? 'battle-install-scrolling-sprite-strip'
          : tiledStrip ? 'battle-install-tiled-sprite-strip'
          : sineStrip ? 'battle-install-sinusoidal-sprite-strip'
          : polygonShatter && boundShatter ? polygonShatterContract.playback.operation
          : verifiedEffect?.operation ?? operationFor(opcode, runtimeContext);
      const instructionContext = scrollingStrip
        ? context('BATTLE_SCROLLING_SPRITE_CONTEXT_REQUIRED', 'battle-loaded-scrolling-sprite-module', 'battle-owner-sprite-packets-and-transform')
        : tiledStrip ? context('BATTLE_TILED_SPRITE_CONTEXT_REQUIRED', 'battle-loaded-tiled-sprite-module', 'battle-owner-sprite-packets-and-transform')
        : sineStrip ? context('BATTLE_SINUSOIDAL_SPRITE_CONTEXT_REQUIRED', 'battle-loaded-sinusoidal-sprite-module', 'battle-owner-sprite-packets-and-transform')
        : polygonShatter && boundShatter
        ? context('BATTLE_POLYGON_SHATTER_CONTEXT_REQUIRED', 'battle-loaded-polygon-shatter-module', ...polygonShatterContract.playback.requiredContexts)
        : contextRequest(opcode, runtimeContext, operands);
      instructionContext?.requiredContexts.forEach((value) => requiredContexts.add(value));
      const unknownBattleEffect = operation === 'battle-effect'
        && runtimeContext === 'battle'
        && instructionContext === null;
      const invalidSoundVoicePair = operation === 'battle-play-actor-seds-effect-on-voice-pair'
        && verifiedEffect.parameters.voicePairSelector >= 16;
      const pendingBattleModel = battleModel && modelRelativeOffset !== 0;
      const blocked = operation === 'unsupported' || unknownBattleEffect || invalidSoundVoicePair || pendingBattleModel;
      const flow = controlFlow(
        offset,
        opcode,
        size,
        operation,
        operands,
        instructionContext,
        blocked,
      );
      const instruction = {
        offset,
        opcode,
        size,
        operation,
        operands,
        parameters: scrollingStrip ? { moduleId: 5, copies: 16, setActorFlagsAC: 0x20 }
          : tiledStrip ? { moduleId: 4, setActorFlagsAC: 0x20 } : sineParameters ?? verifiedEffect?.parameters ?? null,
        controlFlow: flow,
        contextRequest: instructionContext,
        childDefinitionId: null,
        attachmentId: null,
        secondaryEntryId: null,
        resourceReferenceId: null,
        dataReferenceId: null,
      };
      instructions.set(offset, instruction);
      if (polygonShatter && polygonShatterContract !== null && !boundShatter) {
        addDiagnostic('BATTLE_FRAGMENT_MODULE_REFERENCE_UNRESOLVED',
          'The animation entry does not declare the decoded polygon-shatter module; its inherited or alternate implementation remains unidentified.',
          { offset, opcode, declaredFragmentModuleId });
      }

      if (runtimeContext === 'battle') {
        const reference = battleDataReference(bytes, offset, opcode, operands);
        if (reference) {
          if (
            reference.sourceOffset < 0
            || reference.sourceOffset + reference.byteLength > bytes.length
          ) {
            addDiagnostic(
              'SPRITE_DATA_TARGET_INVALID',
              'Sprite embedded-data pointer is outside the animation entry.',
              {
                offset,
                opcode,
                targetOffset: reference.sourceOffset,
                dataBytes: reference.byteLength,
                animationBytes: bytes.length,
              },
            );
          } else {
            const existing = dataReferences.get(reference.id);
            if (existing) existing.opcodeOffsets.push(offset);
            else dataReferences.set(reference.id, { ...reference, opcodeOffsets: [offset] });
            instruction.dataReferenceId = reference.id;
          }
        }
      }

      if (operation === 'unsupported') {
        addDiagnostic('UNSUPPORTED_SPRITE_OPCODE', 'Sprite opcode has no verified semantic operation.', {
          offset, opcode, runtimeContext,
        });
      }
      if (unknownBattleEffect) {
        addDiagnostic('UNKNOWN_BATTLE_SPRITE_EFFECT', 'Battle effect subcommand has no verified semantic operation.', {
          offset, opcode, subcommand: operands[0]?.value,
        });
      }
      if (invalidSoundVoicePair) {
        addDiagnostic('BATTLE_SOUND_VOICE_PAIR_INVALID', 'The encoded selector addresses outside the normal 16-track sound pool.', {
          offset, opcode, subcommand: 0x52, voicePairSelector: verifiedEffect.parameters.voicePairSelector,
          logicalTracks: verifiedEffect.parameters.logicalTracks, trackCount: 16,
        });
      }
      if (pendingBattleModel) {
        const targetOffset = operands[1].value;
        if (targetOffset < 0 || targetOffset + 12 > bytes.length || u24(bytes, targetOffset) !== 0x41 || bytes[targetOffset + 3] !== 0) {
          addDiagnostic('SPRITE_RESOURCE_TARGET_INVALID', 'Battle sprite model pointer does not address a TMD header inside the animation entry.', {
            offset, opcode, targetOffset, animationBytes: bytes.length,
          });
        } else {
          const id = `tmd-model-resource-${targetOffset}`;
          try {
            let reference = resourceReferences.get(id);
            if (reference) reference.opcodeOffsets.push(offset);
            else {
              const decoded = decodeBattleTmdModel(bytes, targetOffset);
              const material = decoded.complete ? decodeBattleTmdTextures(decoded.model.primitives, tmdVram) : null;
              const { authoredScaleWord, ...consumption } = decoded.consumption;
              reference = {
                id, kind: 'tmd-model', targetOffset, objectIndex: 0, opcodeOffsets: [offset],
                geometry: decoded.complete ? {
                  vertices: decoded.model.vertices,
                  verticesAlreadyShifted: decoded.model.verticesAlreadyShifted,
                  normals: decoded.model.normals,
                  primitives: decoded.model.primitives.map(({ index, vertexIndices, normalIndices }) => ({ index, vertexIndices, normalIndices })),
                } : null,
                materials: material?.materials ?? [],
                textures: material?.textures ?? [],
                actorControls: material?.actorControls ?? null,
                sampling: material?.sampling ?? null,
                consumption,
              };
              resourceReferences.set(id, reference);
              for (const value of [...decoded.diagnostics, ...(material?.diagnostics ?? [])]) {
                addDiagnostic(value.code, value.message, { offset, opcode, targetOffset, ...value.details });
              }
            }
            instruction.resourceReferenceId = id;
            // Missing texture ownership prevents a clean asset, but the model's
            // proven structure still permits following the remaining bytecode.
            if (reference.geometry !== null) Object.assign(flow, controlFlow(
              offset, opcode, size, operation, operands, instructionContext, false,
            ));
          } catch (error) {
            addDiagnostic(error.code ?? 'SPRITE_RESOURCE_TARGET_INVALID', error.message, {
              offset, opcode, targetOffset, ...(error.details ?? {}),
            });
          }
        }
      }
      if (opcode === 0xcc) {
        const targetOffset = operands.find(({ name }) => name === 'targetOffset')?.value;
        if (!Number.isInteger(targetOffset) || targetOffset < 0 || targetOffset >= bytes.length) {
          addDiagnostic(
            'SPRITE_SECONDARY_ENTRY_TARGET_INVALID',
            'Sprite secondary-entry pointer is outside the animation entry.',
            { offset, opcode, targetOffset, animationBytes: bytes.length },
          );
        } else {
          const id = `secondary-entry-${targetOffset}`;
          const existing = secondaryEntries.get(id);
          if (existing) existing.opcodeOffsets.push(offset);
          else secondaryEntries.set(id, { id, targetOffset, opcodeOffsets: [offset] });
          instruction.secondaryEntryId = id;
          queue.push(targetOffset);
        }
      }
      if ((opcode >= 0xf5 && opcode <= 0xf7) || opcode === 0xfc) {
        const targetOffset = operands.find(({ name }) => name === 'targetOffset')?.value;
        if (
          !Number.isInteger(targetOffset)
          || targetOffset < offset + size
          || targetOffset >= bytes.length
        ) {
          addDiagnostic(
            'SPRITE_RESOURCE_TARGET_INVALID',
            'Sprite embedded-resource pointer is outside the animation entry.',
            { offset, opcode, targetOffset, animationBytes: bytes.length },
          );
        } else {
          const kind = opcode === 0xfc ? 'vram-upload' : 'model';
          const id = `${kind}-resource-${targetOffset}`;
          const existing = resourceReferences.get(id);
          if (existing) existing.opcodeOffsets.push(offset);
          else resourceReferences.set(id, { id, kind, targetOffset, opcodeOffsets: [offset] });
          instruction.resourceReferenceId = id;
          addDiagnostic(
            'SPRITE_EMBEDDED_RESOURCE_NOT_NORMALIZED',
            'Sprite embedded-resource target still requires a clean resource record.',
            { offset, opcode, targetOffset, kind },
          );
        }
      }

      if (opcode === 0xe0) {
        try {
          const parsed = readSpriteChildDefinition(animationSet, offset);
          const id = `child-${parsed.headerOffset}`;
          const existing = children.get(id);
          if (existing) existing.opcodeOffsets.push(offset);
          else children.set(id, cleanChild(parsed));
          instruction.childDefinitionId = id;
          parsed.animationSet.animations[0].directionTableOffsets.forEach((value) => directionOffsets.add(value));
          queue.push(parsed.sequenceOffset);
        } catch (error) {
          addDiagnostic(error.code ?? 'SPRITE_CHILD_DEFINITION_INVALID', error.message, {
            offset,
            ...(error.details ?? {}),
          });
        }
      }
      if (runtimeContext === 'battle' && opcode === 0xe3) {
        const headerOffset = operands.find(({ name }) => name === 'headerOffset').value;
        try {
          const { directionTableOffsets, ...reference } = targetAnimationReference(bytes, headerOffset);
          const existing = dataReferences.get(reference.id);
          if (existing) existing.opcodeOffsets.push(offset);
          else dataReferences.set(reference.id, { ...reference, opcodeOffsets: [offset] });
          instruction.dataReferenceId = reference.id;
          directionTableOffsets.forEach(value => directionOffsets.add(value));
          queue.push(reference.sequenceOffset);
        } catch (error) {
          addDiagnostic('SPRITE_TARGET_ANIMATION_INVALID', error.message, { offset, opcode, headerOffset });
        }
      }
      if (opcode === 0xbc) {
        const operand = operands[0]?.value;
        const attachment = {
          id: `attachment-${offset}`,
          instructionOffset: offset,
          kind: 'actor-anchor',
          operand,
          anchorType: operand & 0x3f,
          requiredContext: 'actor-anchor-and-transform',
        };
        attachments.push(attachment);
        instruction.attachmentId = attachment.id;
      }

      for (const targetOffset of flow.targetOffsets) {
        if (!Number.isInteger(targetOffset) || targetOffset < 0 || targetOffset >= bytes.length) {
          addDiagnostic('SPRITE_PROGRAM_TARGET_INVALID', 'Sprite control-flow target is outside the animation entry.', {
            offset, opcode, targetOffset, animationBytes: bytes.length,
          });
        } else {
          queue.push(targetOffset);
        }
      }
      if (
        flow.nextOffset !== null
        && (flow.nextOffset < 0 || flow.nextOffset >= bytes.length)
      ) {
        addDiagnostic(
          'SPRITE_PROGRAM_CONTINUATION_INVALID',
          'Sprite control flow continues outside the animation entry.',
          { offset, opcode, nextOffset: flow.nextOffset, animationBytes: bytes.length },
        );
        break;
      }
      if (flow.kind === 'jump' || flow.kind === 'terminate' || flow.kind === 'blocked') break;
      offset = flow.nextOffset;
    }
  }

  const directionTables = [...directionOffsets]
    .sort((left, right) => left - right)
    .map((offset) => directionTable(bytes, offset));

  const program = {
    schema: { name: 'xenogears-sprite-animation-program', version: SPRITE_PROGRAM_SCHEMA_VERSION },
    ticksPerSecond: SPRITE_ANIMATION_TICKS_PER_SECOND,
    runtimeContext,
    ...(usesBattleModels ? { modelPlayback: BATTLE_TMD_PLAYBACK } : {}),
    ...(usesPolygonShatter && boundShatter ? {
      polygonShatter: polygonShatterContract.playback,
      fragmentModule: {
        declaredModuleId: declaredFragmentModuleId,
        behavior: 'polygon-shatter',
        requiredLoadedModuleId: 3,
        requiredWhen: 'each-shatter-callback',
      },
    } : {}),
    roots,
    directionTables,
    instructions: [...instructions.values()].sort((left, right) => left.offset - right.offset),
    children: [...children.values()].map((child) => ({
      ...child,
      opcodeOffsets: [...new Set(child.opcodeOffsets)].sort((left, right) => left - right),
    })).sort((left, right) => left.headerOffset - right.headerOffset),
    secondaryEntries: [...secondaryEntries.values()].map((entry) => ({
      ...entry,
      opcodeOffsets: [...new Set(entry.opcodeOffsets)].sort((left, right) => left - right),
    })).sort((left, right) => left.targetOffset - right.targetOffset),
    resourceReferences: [...resourceReferences.values()].map((reference) => ({
      ...reference,
      opcodeOffsets: [...new Set(reference.opcodeOffsets)].sort((left, right) => left - right),
    })).sort((left, right) => left.targetOffset - right.targetOffset),
    dataReferences: [...dataReferences.values()].map((reference) => ({
      ...reference,
      opcodeOffsets: [...new Set(reference.opcodeOffsets)].sort((left, right) => left - right),
    })).sort((left, right) => (
      left.sourceOffset - right.sourceOffset || left.kind.localeCompare(right.kind)
    )),
    attachments: attachments.sort((left, right) => left.instructionOffset - right.instructionOffset),
    requiredContexts: [...requiredContexts].sort(),
    diagnostics: diagnostics.sort((left, right) => (
      (left.details.offset ?? 0) - (right.details.offset ?? 0)
      || left.code.localeCompare(right.code)
    )),
  };
  return program;
}
