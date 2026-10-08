# Release verification

The first release was built and tested locally on Windows with Blender 5.0.0.
Tests requiring the game used a locally supplied supported Disc 1 BIN. That image,
its extracted resources, the generated Blender files, and motion captures are
excluded from the repository and release.

## Automated source tests

`npm test`: 9 passed, 0 failed.

These tests use synthetic disc payloads and check sector extraction, unsupported
layouts, approved resource coordinates/checksums, standalone CLI help, missing
arguments, and preservation of existing build/import output folders.

## Disc generation

- All 13 required resources passed their expected byte lengths and SHA256 hashes.
- Six battle runtime records were decoded locally, without shipped game records.
- All 81 battle/auxiliary captures and 4,865 frames matched the previously verified
  motion exactly.
- The complete 120-source reference GLB matched the verified export byte for byte:
  SHA256 `28b85291e2a539955669b5851b12e957e14e60fcb294f530a404cb41a56f8903`.

## Blender rig

The public CLI completed a fresh build from the disc. The actual Windows ZIP was
also extracted and its bundled launcher completed a disc-to-rig build, including
paths containing spaces.

Full Blender comparison passed all 120 aliases / 5,813 reference frames, with
maximum position error `0.00017701` Blender units, within the established tolerance.
All 51 native joints, 85 native objects, geometry, UVs, authored normals, materials,
and 14 packed textures were retained. The result has 67 controls and 91 unique
reference actions. Clean IK, FK-default blends, foot/toe following, and built-in
copy/paste, flipped paste, and reset checks passed.

The builder's mechanics and workflow code are the verified Weltall rig code;
public packaging changes the input pipeline, executable path, and documentation.

## Local import

The public CLI imported the generated Blender file into a local model package.
All 91 unique reference actions / 5,117 frames passed comparison across 85 native
objects per frame, with maximum matrix error `0.00017040`.
All seven demonstration actions / 427 frames matched evaluated Blender motion,
with maximum matrix error `0.00001079`. Authoring controls and pose-library assets
were excluded.

## Packaging

The Windows ZIP contains the tool, offline guide, pinned production dependencies,
and Node runtime with their licenses. Its entries are checked against the staging
manifest by size and SHA256. The package allowlist excludes disc images, extracted
game resources, generated models/textures/animations, private output, and credentials.
Use the accompanying `SHA256SUMS.txt` to verify the downloaded archive.

The original Scene01_21 missing-keyframe gap remains labeled PARTIAL. Battle
sampling retains its documented fixed neutral context. Other disc editions and
Blender versions remain unsupported.
