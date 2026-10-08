# Weltall Rig 0.1.0

Build the original Weltall model as an editable Blender 5.0 rig from a supported
Xenogears Disc 1 raw BIN image.

- 67 controls with FK/IK blends, body and pelvis controls, foot/wrist contacts,
  follow spaces, and protected transforms.
- Original model hierarchy and pixel textures, packed into the generated blend.
- 91 unique reference actions covering 120 scene/battle source clips, with
  seven separate contact demonstrations.
- Built-in Blender pose tools, selection/keying sets, and partial neutral poses.
- Offline usage guide and local GLB import of mesh, texture, and animation edits.
- Windows package includes Node and dependencies. Install Blender separately.
- MIT-licensed tool code, with retained third-party notices. No game assets or
  disc image are distributed.

Use a new output folder. Scene01_21 retains its PARTIAL label because the source
references absent keyframe 44. Battle reference motion uses a fixed neutral
context. ISO/CUE input, other disc editions, and other Blender versions are not
supported. Import produces a local model package; it does not patch the game.
