# Weltall Rig

Build an editable Blender rig for the original Weltall model from your own Xenogears Disc 1 image.

The build preserves the original mesh parts, hierarchy, pivots, pixel textures, and reference motion. It adds 67 animator controls with FK/IK blending, foot and wrist contacts, body offsets, follow spaces, and Blender pose tools. The audited animation library contains 91 unique actions representing 120 scene and battle source clips. Seven separate `DEMO/` actions show how to use the controls.

This repository and its release contain tool code, not game models, textures, animations, or a disc image. You supply the disc and generate those files locally.

## Requirements

- Windows and Blender **5.0**, installed separately.
- A supported Xenogears Disc 1 **raw Mode 2 / 2352-byte-sector `.bin`** image.
- Enough disk space for the generated model package and Blender file.

The known disc layout and Blender 5.0 are tested. ISO input, CUE parsing, other disc editions, and other Blender versions are not supported by this release.

## Build from a release

Extract the release ZIP and open a terminal in that folder. The Windows package includes Node, so no separate Node installation is needed.

```powershell
.\weltall-rig.cmd build "D:\Games\Xenogears Disc 1.bin" --blender "C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" --out "D:\Weltall"
```

Choose a new output folder. The command does not modify the disc image or an open Blender session. It reads the required disc resources, builds the model and animation package, and runs Blender separately to create the rig.

The output includes:

```text
Weltall/
  weltall-rigged.blend       Model, packed textures, rig, reference actions, demos
  guide.html                Offline usage guide; open in a browser or print to PDF
  rig-report.json           Rig controls and animation coverage
  build-report.json         Input and build information
  original/weltall/         Original model package needed for later import
```

Keep the entire output folder. The `.blend` contains its textures, but importing edits also needs `original/weltall`.

## Open and enable the controls

1. Open `weltall-rigged.blend` in Blender 5.0.
2. Open the **Scripting** workspace. In the Text Editor's text dropdown, select **RIG CONTROLS - Run Script**.
3. Hover over the Text Editor and press **Alt+P**, or click **Run Script ▶**.
4. Return to **Layout**, select the rig, and enter **Pose Mode**.
5. Press **N** in the 3D viewport and open the **Weltall Rig** tab.

Run the embedded script once each time you reopen Blender. No add-on installation or automatic script execution is required. The controls and ordinary Bone Properties custom properties also work without the sidebar.

The file opens in FK: each wrist and foot has `ik_blend = 0`. Set a limb's target and pole, then blend toward `1` for IK. There are no FK/IK snap or matching tools. Read [the offline guide](docs/guide.html) for editing actions, contacts, follow changes, and reset steps; [the control map](docs/CONTROL_MAP.md) lists every control.

## Import your edits into a local model package

Save a separate edited `.blend`. Keep the original object names, parents, origins, and material assignments. Reshape mesh vertices and edit UVs at frame 1; do not join model objects or apply the rig's constraints.

```powershell
.\weltall-rig.cmd import "D:\Weltall\weltall-edited.blend" --blender "C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" --original "D:\Weltall\original\weltall" --out "D:\Weltall-edited"
```

Import bakes evaluated FK/IK motion onto the original 51-joint hierarchy and writes an edited local GLB/model package. It omits authoring controls and pose-library assets. This is **not** a patcher or importer for the original game disc/BIN format.

## Animation coverage

- The 91 unique reference actions represent 120 audited Weltall scene and battle clips. Source aliases and timeline ranges are recorded in `rig-report.json` and the blend's **SOURCE ANIMATION COVERAGE** text.
- The library is limited to original Weltall. Weltall-2, Xenogears, and Id are not included.
- Scene08 motion uses the audited mapping onto the canonical battle skeleton.
- `Scene01_21` remains labeled **PARTIAL** because source keyframe 44 is absent.
- Battle motion uses a fixed neutral capture context. Cameras, sound, particles, and context-dependent battle effects are not model animation.
- The seven `DEMO/` actions are editable control studies, separate from the original references.

## Build from source

Install Node **24 or newer** and Blender 5.0, then run:

```powershell
npm ci
node cli.mjs build "D:\Games\Xenogears Disc 1.bin" --blender "C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" --out "D:\Weltall"
```

Use the same `import` arguments with `node cli.mjs` when working from source. Run `npm test` for the tool's automated tests.

## License

The tool's original code is licensed under the [MIT License](LICENSE): use, modify, and redistribute it, including commercially, with the license notice retained. Third-party code retains its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The code license does not grant rights to Xenogears or to models, textures, animations, and other assets extracted from a disc. Those assets retain their respective owners' rights. Supply your own disc image; do not commit generated assets or disc images to this repository.
