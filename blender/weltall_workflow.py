"""Saved selection groups, reset defaults, partial pose assets, and animator guide."""
import json
from pathlib import Path

import bpy
from bpy_extras.anim_utils import action_ensure_channelbag_for_slot


def _groups(rig):
    controls = [p.name for p in rig.pose.bones if p.name.startswith('CTRL-') and not p.bone.hide_select]
    groups = {'Whole Body': controls}
    arm = ('arm', 'shoulder', 'clavicle', 'hand', 'elbow', 'wrist')
    leg = ('thigh', 'shin', 'ankle', 'foot', 'toe', 'knee', 'heel', 'ball', 'bank')
    for label, tokens in (('Arm', arm), ('Leg', leg)):
        for side in ('L', 'R'):
            groups[f'{label} {side}'] = [n for n in controls if n.endswith('.' + side)
                                          and any(t in n for t in tokens)]
    limbs = {n for label, names in groups.items() if label != 'Whole Body' for n in names}
    groups['Body'] = [n for n in controls if n not in limbs]
    return groups


def _neutral_pose_asset(rig, label, names):
    if label == 'Body':
        names = [name for name in names if name != 'CTRL-root']
    action = bpy.data.actions.new('Weltall Pose - ' + label + ' Neutral')
    action['weltall_pose_asset'] = True
    action.asset_mark()
    action.asset_data.description = 'Partial neutral pose for ' + label + '; other controls are unchanged.'
    action.asset_data.tags.new('Pose')
    action.asset_data.tags.new('Weltall')
    slot = action.slots.new(id_type='OBJECT', name=rig.name)
    bag = action_ensure_channelbag_for_slot(action, slot)
    for name in names:
        bone = rig.pose.bones[name]
        channels = [('location', list(bone.location), bone.lock_location)]
        if bone.rotation_mode == 'QUATERNION':
            channels.append(('rotation_quaternion', list(bone.rotation_quaternion), [all(bone.lock_rotation)] * 4))
        else:
            channels.append(('rotation_euler', list(bone.rotation_euler), bone.lock_rotation))
        for channel, values, locks in channels:
            for index, value in enumerate(values):
                if not locks[index]:
                    curve = bag.fcurves.new(bone.path_from_id(channel), index=index, group_name=name)
                    curve.keyframe_points.insert(1, value).interpolation = 'CONSTANT'
        for key in bone.keys():
            if isinstance(bone[key], (int, float)):
                curve = bag.fcurves.new(bone.path_from_id() + '["' + bpy.utils.escape_identifier(key) + '"]',
                                       index=0, group_name=name)
                curve.keyframe_points.insert(1, bone[key]).interpolation = 'CONSTANT'
    return action.name


GUIDE = '''WELTALL ANIMATION GUIDE

START
Frame 1 is the original neutral model. The Reference animations NLA track retains
all 91 unique source actions and their 120 aliases. IK begins clean and every
blend is FK. Source rotations stay quaternion-based. New contact controls use
their documented rotation channels; do not change reference rotation modes.
Open the Scripting workspace. In the Text Editor's text dropdown, select
RIG CONTROLS - Run Script; hover over that editor and press Alt+P (Run Script).
Return to Layout, select the rig, enter Pose Mode, and press N in the 3D viewport.
Open the Weltall Rig tab. Run the script once each time you reopen Blender.
It registers the sidebar and dynamic keying sets; no add-on or automatic script
execution is required. Bone Properties custom properties remain available.
The build's guide.html is the printable offline guide.

EDIT A REFERENCE WITHOUT LOSING IT
Select its strip in the NLA Editor. Duplicate the strip with Shift+D and move the
copy to a separate working track. Use Edit > Make Single User (U) on the copy,
rename its action, and keep the original Reference animations track intact.
Select the copied strip and press Tab for NLA Tweak Mode. Edit that working action
in the Action Editor; press Tab in NLA again to leave Tweak Mode. Mute competing
tracks when editing a standalone clip. For fresh animation, mute the Reference
animations track and create a new Action in the Action Editor. Give it a clear
name and enable its shield/Fake User if it has no NLA strip.

POSE AND KEY
Use the saved whole-body and limb selection sets in Armature Data Properties,
or the sidebar Select buttons. The sidebar Key buttons and Weltall keying sets
key editable active channels: FK at blend 0, IK at blend 1, both between them.
Hand, blend, and follow properties are included. Inactive IK transforms are not
needlessly keyed. Selecting only a detail control keys only that control.
Use built-in Copy Pose, Paste Pose, Paste Flipped Pose, and X-axis mirroring.
For pose sliding, the working action needs surrounding keys; Blender's Breakdown,
Push/Relax and Blend to Neighbor tools then operate on selected controls.
Alt+G / Alt+R clear editable location/rotation. Reset a property with Backspace
over its field. Clear Transforms does not reset custom properties.
The Asset Browser's Current File library contains partial Body/Arm/Leg Neutral
poses. Apply or blend these to reset one region without disturbing the others;
Apply Pose Flipped uses matching .L/.R controls. Select the controls to affect
before applying an asset. Make your own partial assets from selected controls
with Pose > Pose Library > Create Pose Asset.

IK, CONTACTS, FOLLOWING
CTRL-root places the character; CTRL-body shifts the full body weight while
root/world IK goals stay planted. CTRL-pelvis offsets legs and skirt independently
of the upper torso. CTRL-chest_pose turns shoulders, torso shell, head and wings
together. Legacy CTRL-hips is the torso base; legacy CTRL-chest is the shoulder
girdle. Their original names and animation curves remain intact.
At the wrist/foot, ik_blend runs smoothly from 0 FK to 1 IK. Pose the IK target
and pole before blending toward them; there is no automatic FK/IK matching.
Wrists keep hand shape at hand: 0 open, 1 closed, 2 both, 3 hidden. Values 2 and 3
retain the extracted visibility scripts. Foot/toe detail controls follow the
evaluated ankle. Contact controls rotate around the named heel, toe, foot edge,
or wrist pivot; keep rigid parts at their fixed length. Poles choose the bend
direction; avoid crossing a fully straight limb with its pole.
Heel and toe contact controls use local X for pitch and Z for swivel; the ball
control uses X for heel lift with a planted toe. Bank uses Y for edge rocking.
These offsets are zero by default. Native foot/toe FK remains available for
individual parts. Move wrist_pivot to place a contact, then rotate hand_contact
around it; moving the pivot alone leaves the hand still.
The Body Neutral pose asset preserves global root placement.
Follow choices define which body part carries the control. Use Change Follow
(Keep Pose) in the sidebar to change parent relationships without a jump.
The raw follow property remains directly accessible; changing it directly does
not compensate the pose. Follow switching changes parent space, not FK/IK mode.
The button keys the old pose/space one frame earlier and the compensated pose/new
space at the current frame, with stepped follow keys. It also works in NLA Tweak
Mode. Use it on your working action; this is an animation edit even with Auto Key off.

DEMOS AND CLEAN ACTION SWITCHING
Seven separate DEMO/ actions (frames 1-61) demonstrate Walk contacts, Weight
transfer, Crouch, Landing, Punch, Bracing, and Follow and blend. These are editable
contact studies, not original game motion. The 91 reference actions stay separate.
Before switching demos or returning to references, leave NLA Tweak Mode and turn
Auto Key off. Mute Reference animations and clear the active Action with its X.
Select Whole Body in Pose Mode and fully apply all five Current File neutral pose
assets (Body, Arm L/R, Leg L/R). Then select CTRL-root and use Alt+G and Alt+R.
Choose the next demo/action. For reference playback, leave the Action empty,
unmute Reference animations, and scrub to the intended frame. Pose assets reset
custom properties as well as transforms; Clear Transforms alone does not.

SAVE AND BAKE
Reset to neutral at frame 1 before reshaping the model in Edit Mode. Keep original
object names, hierarchy, origins, transforms, and material assignments. Edit mesh
vertices/UVs; do not apply rig constraints or join original model objects.
Save a separate working .blend and keep the build's original/weltall folder.
Import bakes evaluated motion onto the original 51-joint hierarchy and strips
authoring controls from the local GLB. From the release directory run:
weltall-rig.cmd import <edited.blend> --blender <blender-executable> --original <build-folder>/original/weltall --out <new-folder>
Source users replace weltall-rig.cmd with node cli.mjs.
Pose library assets are authoring aids and are not exported as animation clips.
Key channels you intend an action to own. Export restores animation-controlled
channels to their recorded neutral values between independent actions; a keyed
frame-one pose cannot contaminate another clip. Unkeyed manual offsets remain
shared across actions until you key them.
The target is the local model package, not the original game BIN/disc format.

SOURCE COVERAGE
Only the audited original Weltall library is included, not Weltall-2, Xenogears,
or Id. Scene08 uses the audited canonical-skeleton mapping. Scene01_21 remains
PARTIAL because source keyframe 44 is absent. Battle motion uses a fixed neutral
capture context; cameras, sound, particles, and missing motion are not recreated.
SOURCE ANIMATION COVERAGE records the 120 source aliases and timeline ranges.
'''


def setup_workflow(rig):
    """Run once at neutral frame 1 after final controls/properties are installed."""
    assert bpy.context.scene.frame_current == 1, 'Capture neutral workflow assets at frame 1'
    groups = _groups(rig)
    rig['control_groups'] = json.dumps(groups)
    rig['weltall_workflow'] = 1
    for label, names in groups.items():
        selection = rig.selection_sets.add()
        selection.name = label
        for name in names:
            selection.bone_ids.add().name = name
    defaults = {}
    for bone in rig.pose.bones:
        if bone.name not in groups['Whole Body']:
            continue
        defaults[bone.name] = {}
        for key in bone.keys():
            value = bone[key]
            if isinstance(value, (int, float)):
                bone.id_properties_ui(key).update(default=value)
                defaults[bone.name][key] = value
    rig['control_defaults'] = json.dumps(defaults)
    # Export resets animation-controlled channels to these neutral values between
    # actions. A frame-1 pose in one working action must not leak into another.
    rig['animation_neutral'] = json.dumps({bone.name: {
        **{channel: list(getattr(bone, channel)) for channel in
           ('location', 'rotation_quaternion', 'rotation_euler', 'scale')},
        'properties': {key: bone[key] for key in bone.keys() if isinstance(bone[key], (int, float))}
    } for bone in rig.pose.bones})
    assets = [_neutral_pose_asset(rig, label, groups[label])
              for label in ('Body', 'Arm L', 'Arm R', 'Leg L', 'Leg R')]
    rig['pose_assets'] = json.dumps(assets)
    text = bpy.data.texts.get('RIG CONTROLS - Run Script') or bpy.data.texts.new('RIG CONTROLS - Run Script')
    text.clear()
    text.write((Path(__file__).parent / 'weltall_rig_ui.py').read_text(encoding='utf-8'))
    guide = bpy.data.texts.new('WELTALL ANIMATION GUIDE')
    guide.write(GUIDE)
    bpy.data.texts['READ ME'].write('\n\nFor working actions, contacts, selection/keying sets and partial pose assets,\nread WELTALL ANIMATION GUIDE.\n')
    return {'selectionSets': list(groups), 'poseAssets': assets,
            'keyingSets': 'Whole Body, Body, Arm L/R, Leg L/R, Selected; registered by embedded UI',
            'guide': guide.name}
