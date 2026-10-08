# Weltall Rig 0.1.0

Turn your own Xenogears Disc 1 image into an editable Weltall rig for Blender.
No programming experience is needed. You will copy one command to generate the
file, then work in Blender normally.

The rig preserves the original mesh, hierarchy, pivots, and pixel textures. It
adds 67 controls with FK/IK blending, body and pelvis controls, foot and wrist
contacts, follow spaces, and locked transforms. There are 91 unique reference
actions representing 120 scene and battle clips, plus seven separate control
demonstrations. The tool code is MIT-licensed; third-party notices are included.

## 1. Download what you need

- A **Windows 64-bit** computer.
- **Blender 5.0.x**, installed separately. If you need that version, use
  [Blender's official previous versions page](https://www.blender.org/download/previous-versions/).
  This release checks for Blender 5.0; another version will not work.
- Your own supported **Xenogears Disc 1 `.bin` image**: raw Mode 2, with
  2352-byte sectors. This download contains no disc image or game assets.
- The **`weltall-rig-0.1.0-windows-x64.zip`** file under **Assets** on this release
  page. Download that file, rather than either **Source code** archive. It includes
  Node and the required dependencies, so you do not need to install them yourself.

Right-click the downloaded ZIP in File Explorer, choose **Extract All**, and
extract it. Open the extracted folder, then its inner folder if necessary, until
you can see **`weltall-rig.cmd`**, **`cli.mjs`**, and the **`runtime`** folder.
Run the tool from this extracted folder, not from inside the ZIP.

## 2. Generate your Blender file

### Open PowerShell in the tool folder

In the extracted folder containing **`weltall-rig.cmd`**, click File Explorer's
address bar, type **`powershell`**, and press **Enter**. A command window opens
with this folder as its working location. Keep it open while the build runs.

### Copy and run this command

First copy this command into **Notepad** so you can change the example paths
before running it:

```powershell
.\weltall-rig.cmd build "D:\Games\Xenogears Disc 1.bin" --blender "C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" --out ".\Weltall-output"
```

1. Find your Disc 1 `.bin` in File Explorer. Right-click it and choose
   **Copy as path**. This copies its full location, including quotation marks.
   In Notepad, replace the entire first quoted path, including its quotes,
   with what you copied.
2. Find **`blender.exe`** in your Blender 5.0 installation folder. The usual
   location is `C:\Program Files\Blender Foundation\Blender 5.0\blender.exe`.
   Use **Copy as path** on that file and replace the entire quoted path after
   **`--blender`** with it. If the example is already your exact installation
   location, you can leave it as shown.
3. Keep the command on **one line**, keep the quotation marks around each path,
   and leave the rest as shown. Copy the completed line from Notepad into
   PowerShell and press **Enter**.

The `--out` part names the folder the tool will create. **Do not create `Weltall-output`
yourself**: the tool requires a new folder and will refuse to overwrite one.

The tool reads and verifies the disc resources, extracts the model and reference
animations, and runs Blender in the background to build the rig. It may take a
few minutes. Wait until you see **`Created ...weltall-rigged.blend`** and the
PowerShell prompt returns. It does not modify your disc image.

Open the new **`Weltall-output`** folder. You should find:

- **`weltall-rigged.blend`** — the model, packed textures, rig, and animations.
- **`guide.html`** — the detailed offline animator guide; double-click to read it
  in your browser.
- **`original\weltall`** — the original model package needed to import edits later.
- **`rig-report.json`** and **`build-report.json`** — build and animation coverage
  records; you do not need to edit these.

Keep the whole output folder, including **`original`**.

## 3. Open the rig and enable its controls

1. Start **Blender 5.0** and use **File → Open** to open
   `Weltall-output\weltall-rigged.blend`.
2. Choose the **Scripting** workspace at the top of Blender.
3. In the **Text Editor**, open the text dropdown and select
   **`RIG CONTROLS - Run Script`**.
4. Place your mouse over the Text Editor and press **Alt+P**, or click its
   **Run Script ▶** button. You do not need to write or change any Python.
5. Return to **Layout**. Select **`Weltall RIG`** in the Outliner, the object list
   normally shown at the top right.
6. In the 3D viewport's mode dropdown, ensure **Pose Mode** is selected.
7. Place your mouse over the 3D viewport and press **N**. Open the
   **Weltall Rig** tab in the sidebar that appears.

Run the embedded script again after reopening Blender. No add-on installation
or global automatic script execution is required. Use **Material Preview**
viewport shading to see the packed pixel textures.

## 4. Preview animations and try the rig

### Watch the original motion

Frame **1** is neutral. The **Reference animations** track plays the unique
scene and battle actions back-to-back starting at frame **31**, at 30 fps.
Set the Timeline to frame 31 and press **Spacebar** with your mouse over the
Timeline to play or pause. Scrub the Timeline to explore the clips.

Use **File → Save As** to save a separate **`weltall-edited.blend`** in
`Weltall-output` before experimenting, keeping the generated file as your original.

### Make a working copy of a reference animation

1. Change a suitable area, such as the Timeline, to **Nonlinear Animation** using
   the editor-type button at that area's top or bottom left.
2. On the **Reference animations** track, select the animation strip you want.
   Press **Shift+D** to duplicate it and move the copy onto a separate working
   track. Click to confirm its placement.
3. With the copy selected, use **Edit → Make Single User** (**U**) so edits affect
   its own action, rather than the original.
4. Mute the original reference track and any competing tracks using their mute
   controls. Select the copied strip and press **Tab** with your mouse over the
   Nonlinear Animation editor to enter **Tweak Mode**.
5. Open a **Dope Sheet** editor and set its mode to **Action Editor**. Rename the
   working action there, then edit and key it. Press **Tab** in the Nonlinear
   Animation editor again when finished to leave Tweak Mode.

For an animation from scratch, mute **Reference animations**, create a **New**
action in the Action Editor, and name it. Enable the action's shield/**Fake User**
button if it has no NLA strip, so Blender keeps it when you save.

### Move and key the controls

- **Blue** controls are left, **red** are right, and **gold** are central.
- Select a control in **Pose Mode**. **G** moves it and **R** rotates it where
  those transforms are allowed. Scale and unsuitable channels are locked.
- **FK** means rotating joints directly: use the limb rings. All imported
  reference animations start in FK.
- **IK** means positioning a hand or foot and letting the limb solve around it.
  Position the wrist/foot **box** and its elbow/knee **diamond** pole. Select the
  wrist/foot box and move its sidebar **FK / IK** slider from **0** (FK) toward
  **1** (IK). Intermediate values blend smoothly. IK is initially unanimated;
  there is no automatic pose matching when you change the blend.
- **`CTRL-root`** places the entire character. **`CTRL-body`** shifts body weight,
  **`CTRL-pelvis`** moves the leg sockets and skirt, and **`CTRL-chest_pose`** turns
  the upper body together. The legacy hips/chest controls retain their original,
  narrower roles, explained in the offline guide.
- Each wrist's **Hand** setting swaps hand parts: **0 open**, **1 closed**,
  **2 both**, **3 hidden**. Rest/reset defaults to **2**.
- At the frame you want, use the appropriate **Key** button under
  **Select / Key Controls** in the sidebar, such as **Arm L** or **Leg R**.
  Moving a control alone does not record its motion. These buttons also key the
  relevant blend, hand, and follow settings.

For foot rolls, hand-contact pivots, follow spaces, pose mirroring, resets, and
the seven **`DEMO/`** actions, open **`guide.html`** in your output folder. Follow
its reset procedure before switching demos or returning to references:
**clearing transforms alone does not reset hand, blend, or follow settings**.
Key offsets that should belong to just one action; unkeyed offsets remain shared.

To reshape the model, reset to neutral at frame 1 and edit an original mesh's
vertices or UVs in **Edit Mode**. Keep original object names, parents, origins,
transforms, and material assignments. Do not join separate model objects, rename
native joints, or apply the rig's constraints.

## 5. Import your edits into a local model package

Save your **`weltall-edited.blend`**, then return to PowerShell in the extracted
tool folder. With the filenames above, run this command, replacing the Blender
path if needed:

```powershell
.\weltall-rig.cmd import ".\Weltall-output\weltall-edited.blend" --blender "C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" --original ".\Weltall-output\original\weltall" --out ".\Weltall-edited-output"
```

The edited output folder must also be new. Wait for **`Replacement written to`**.
The tool bakes evaluated FK/IK and contact motion onto the original 51-joint
hierarchy and writes an edited local GLB/model package, including **`model.glb`**.
Authoring controls and neutral pose assets are omitted. All saved local rig
actions, including references and demos, are baked; muting a track is not an
action-export filter. An unmuted working NLA track also produces an
**Edited timeline** animation.

**This tests the asset editing and reimport workflow. It does not insert edits
into Xenogears, patch the disc image, or write the original game BIN format.**

## If something goes wrong

- **The command is not recognized:** open PowerShell in the extracted folder
  containing `weltall-rig.cmd` and keep the leading `.\` in the command.
- **A file cannot be found:** check both copied paths, quotation marks, and that
  the Blender path points to `blender.exe`, not a shortcut.
- **Blender 5.0 is required:** point to a Blender **5.0.x** installation.
- **Output already exists:** choose a new name after `--out`, such as
  `.\Weltall-output-2`. Do not discard an existing folder containing your work.
- **Unsupported disc layout or checksum mismatch:** the image is unsupported
  or damaged. Renaming an ISO to `.bin` does not convert it. This release does
  not parse `.cue` files or support other disc editions.
- **The sidebar is missing:** run `RIG CONTROLS - Run Script`, select
  `Weltall RIG`, enter Pose Mode, then press N over the 3D viewport.
- **Posing does not behave as expected:** check that competing reference tracks
  are muted and the limb's FK / IK blend selects the controls you are using.
  Follow the offline guide's full neutral reset procedure if needed.

When reporting a problem, include the complete error message, your Blender
version, and which step failed. Do not upload your disc image or extracted assets.

## Coverage and limitations

- This release contains **original Weltall only**. Weltall-2, Xenogears, and Id
  are not included.
- `Scene01_21` retains its **PARTIAL** label because source keyframe 44 is absent.
- Battle reference motion uses a fixed neutral capture context. Cameras, sound,
  particles, and context-dependent battle effects are outside model animation.
- The supported raw Disc 1 layout and Blender 5.0 are tested. ISO/CUE input,
  other disc editions, and other Blender versions are unsupported.
- The MIT license applies to the tool code. Extracted game assets retain their
  respective owners' rights; no game assets or disc image are distributed here.
