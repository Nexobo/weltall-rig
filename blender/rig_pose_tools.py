"""Mirror-friendly controls over the unchanged native mechanical skeleton."""
import json

import bpy
from mathutils import Matrix, Vector


def action_curves(action):
    return [curve for layer in action.layers for strip in layer.strips
            for bag in strip.channelbags for curve in bag.fcurves]


def rebase_curves(action, name, rotation):
    curves = action_curves(action)
    for channel, indices in (('rotation_quaternion', (1, 2, 3)), ('location', (0, 1, 2))):
        path = f'pose.bones["{name}"].{channel}'
        group = {curve.array_index: curve for curve in curves if curve.data_path == path}
        if not group:
            continue
        assert all(i in group for i in indices), (action.name, name, 'Incomplete transform curves')
        components = [group[i] for i in indices]
        times = [[key.co.x for key in curve.keyframe_points] for curve in components]
        assert times[0] == times[1] == times[2], (action.name, name, 'Unaligned transform keys')
        assert not any(curve.modifiers for curve in components)
        for keys in zip(*(curve.keyframe_points for curve in components)):
            assert len({key.interpolation for key in keys}) == 1
            assert keys[0].interpolation in ('LINEAR', 'CONSTANT')
            for attribute in ('co', 'handle_left', 'handle_right'):
                values = rotation @ Vector([getattr(key, attribute).y for key in keys])
                for key, value in zip(keys, values):
                    getattr(key, attribute).y = value
        for curve in components:
            curve.update()


def prepare_pose_controls(rig):
    """Preserve native output/IK frames; rebase only the visible controls."""
    assert not rig.get('pose_controls_prepared'), 'Rig controls are already prepared'
    fk = {int(i): name for i, name in json.loads(rig['original_joint_map']).items()}
    rest = {bone.name: bone.matrix_local.copy() for bone in rig.data.bones}
    parents = {bone.name: bone.parent.name if bone.parent else None for bone in rig.data.bones}
    controls = [p.name for p in rig.pose.bones if p.name.startswith('CTRL-')
                and p.name not in ('CTRL-palm.L', 'CTRL-palm.R')]
    bases = {name: rig.pose.bones[name].matrix_basis.copy() for name in controls}
    shape_rotations = {name: rig.pose.bones[name].custom_shape_rotation_euler.to_matrix()
                       for name in controls}
    native = {i: f'MCH-native-{i:03}' if name in controls else name for i, name in fk.items()}
    renamed_parents = {fk[i]: native[i] for i in fk if fk[i] != native[i]}
    sockets = {name: f'MCH-axis-{i:03}' for i, name in fk.items() if name in controls}
    limbs = json.loads(rig['limbs'])
    sockets.update({limb['target']: 'MCH-axis-' + limb['name'] for limb in limbs})
    corrections = {name: rest[name].to_quaternion().to_matrix() for name in controls}
    actions = {strip.action for track in rig.animation_data.nla_tracks for strip in track.strips
               if strip.action}
    if rig.animation_data.action:
        actions.add(rig.animation_data.action)
    assert not any(action.library for action in actions), 'Edit a local rig/action copy'

    # Blender mirrors matching property names along with the bone transform.
    hands = json.loads(rig['hands'])
    property_paths = {}
    for records, field, new_name, description in (
            (limbs, 'switch', 'ik_blend', '0 = FK / reference, 1 = IK'),
            (hands, 'property', 'hand', 'Hand shape: 0 = open, 1 = closed')):
        for record in records:
            p = rig.pose.bones[record['control']]
            old_name = record[field]
            p[new_name] = p[old_name]
            native_hand = field == 'property' and record.get('native')
            p.id_properties_ui(new_name).update(min=0, max=3 if native_hand else 1,
                description='Hand: 0 open, 1 closed, 2 both, 3 hidden' if native_hand else description)
            property_paths[p.path_from_id() + f'["{old_name}"]'] = p.path_from_id() + f'["{new_name}"]'
            del p[old_name]
            record[field] = new_name
    for action in actions:
        for curve in action_curves(action):
            if curve.data_path in property_paths:
                curve.data_path = property_paths[curve.data_path]
    for obj in bpy.context.scene.objects:
        for curve in obj.animation_data.drivers if obj.animation_data else []:
            for variable in curve.driver.variables:
                for target in variable.targets:
                    if target.id == rig and target.data_path in property_paths:
                        target.data_path = property_paths[target.data_path]
    rig['limbs'] = json.dumps(limbs)
    rig['hands'] = json.dumps(hands)

    bpy.context.view_layer.objects.active = rig
    if rig.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.mode_set(mode='EDIT')
    bones = rig.data.edit_bones
    for i, name in fk.items():
        if name == native[i]:
            continue
        bone = bones.new(native[i])
        bone.length = bones[name].length
        bone.matrix = rest[name]
        bone.use_deform = False
    # Native parents remain native. In particular, feet retain their OUT-ankle parent.
    for name, parent in parents.items():
        if parent in renamed_parents:
            bones[name].parent = bones[renamed_parents[parent]]
    for i, name in fk.items():
        if name == native[i]:
            continue
        parent = parents[name]
        bones[native[i]].parent = bones[renamed_parents.get(parent, parent)] if parent else None
    for name in controls:
        bones[name].matrix = Matrix.Translation(rest[name].translation)
    for name, socket in sockets.items():
        bone = bones.new(socket)
        bone.length = bones[name].length
        bone.matrix = rest[name]
        bone.parent = bones[name]
        bone.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')

    mechanism = rig.data.collections['Mechanism']
    for name in [*renamed_parents.values(), *sockets.values()]:
        mechanism.assign(rig.data.bones[name])
        rig.data.bones[name].hide_select = True
        rig.pose.bones[name].rotation_mode = 'QUATERNION'
    for i, name in fk.items():
        if name == native[i]:
            continue
        constraint = rig.pose.bones[native[i]].constraints.new('COPY_TRANSFORMS')
        constraint.name = 'Native axes from pose control'
        constraint.target, constraint.subtarget = rig, sockets[name]
        constraint.owner_space = constraint.target_space = 'WORLD'
        for owner in (f'OUT-{i:03}', f'MCH-result-{i:03}'):
            baseline = next(c for c in rig.pose.bones[owner].constraints
                            if c.type == 'COPY_TRANSFORMS' and c.subtarget == name)
            baseline.subtarget = native[i]
            assert baseline.owner_space == baseline.target_space == 'LOCAL'
    for limb in limbs:
        constraint = rig.pose.bones['MCH-end-' + limb['name']].constraints[0]
        assert constraint.type == 'COPY_ROTATION' and constraint.subtarget == limb['target']
        constraint.subtarget = sockets[limb['target']]
    for name in controls:
        correction = corrections[name]
        p = rig.pose.bones[name]
        p.matrix_basis = correction.to_4x4() @ bases[name] @ correction.transposed().to_4x4()
        p.custom_shape_rotation_euler = (correction @ shape_rotations[name]).to_euler()
        for action in actions:
            rebase_curves(action, name, correction)
    rig['native_joint_map'] = json.dumps(native)
    rig['pose_controls_prepared'] = 1
    rig.data.use_mirror_x = True
    rig.update_tag()
    bpy.context.view_layer.update()
    return {'controls': len(controls), 'nativeAxesPreserved': True,
            'mirroring': 'Blender X-axis mirror and flipped pose paste',
            'editing': 'Select a reference strip in the NLA Editor and press Tab to edit its Action.'}


def exit_action_editing(rig):
    """Leave native NLA Tweak Mode before baking independent actions."""
    if not rig.animation_data.use_tweak_mode:
        return
    area = next(area for area in bpy.context.screen.areas if area.type == 'VIEW_3D')
    previous = area.type
    area.type = 'NLA_EDITOR'
    with bpy.context.temp_override(area=area):
        bpy.ops.nla.tweakmode_exit()
    area.type = previous


def pose_instructions(scene):
    text = bpy.data.texts['READ ME']
    text.write('''

POSE EDITING
Visible controls use consistent axes; X-axis pose mirroring is enabled.
Copy/Paste Pose, Paste Flipped Pose and Clear Transform operate on the controls.
Paste Flipped Pose also copies the IK blend and hand shape.
For pose sliding or animation edits, select a clip in the NLA Editor and press Tab
to enter Tweak Mode. The Action Editor then edits that clip. Press Tab again to
return to the complete reference timeline. Key edits with I to keep them.
The importer leaves Tweak Mode before baking your edited actions.
''')
    # Show the existing Blender editor where reference clips can be selected/edited.
    for area in bpy.context.screen.areas:
        if area.type == 'DOPESHEET_EDITOR' and area.spaces.active.mode == 'TIMELINE':
            area.type = 'NLA_EDITOR'
