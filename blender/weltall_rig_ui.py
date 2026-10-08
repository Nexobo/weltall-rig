"""Embedded Weltall animation tools. Run this text once after opening the file."""
import json

import bpy
from bpy.props import IntProperty, StringProperty


GROUPS = (('Whole Body', 'WHOLE'), ('Body', 'BODY'), ('Arm L', 'ARM_L'),
          ('Arm R', 'ARM_R'), ('Leg L', 'LEG_L'), ('Leg R', 'LEG_R'),
          ('Selected', 'SELECTED'))
LABELS = {'CTRL-root': 'Character placement', 'CTRL-body': 'Body weight / COG',
          'CTRL-pelvis': 'Pelvis and skirt', 'CTRL-hips': 'Torso base (legacy hips)',
          'CTRL-chest_pose': 'Chest', 'CTRL-chest': 'Shoulder girdle (legacy chest)',
          'CTRL-torso_armor': 'Torso shell'}


def active_rig(context):
    rig = context.object
    return rig if rig and rig.type == 'ARMATURE' and rig.get('weltall_workflow') else None


def group_bones(rig, group):
    if group == 'Selected':
        return [p.name for p in rig.pose.bones if p.select and p.name.startswith('CTRL-')
                and not p.bone.hide_select]
    return json.loads(rig['control_groups'])[group]


def keyed_channels(rig, group):
    """Only channels that contribute at the current FK/IK blend are keyed."""
    names = set(group_bones(rig, group))
    inactive = set()
    for limb in json.loads(rig['limbs']):
        target = rig.pose.bones[limb['control']]
        blend = float(target[limb['switch']])
        ik = {limb['target'], limb['pole'], *limb.get('contact_controls', [])}
        if blend <= 0:
            inactive.update(ik)
        elif blend >= 1:
            inactive.update(limb['fk'])
    for name in sorted(names):
        bone = rig.pose.bones[name]
        if name not in inactive:
            for index, locked in enumerate(bone.lock_location):
                if not locked:
                    yield bone, 'location', index
            if not all(bone.lock_rotation):
                if bone.rotation_mode == 'QUATERNION':
                    # A quaternion is a coupled rotation; key all four components.
                    for index in range(4):
                        yield bone, 'rotation_quaternion', index
                else:
                    rotation = 'rotation_axis_angle' if bone.rotation_mode == 'AXIS_ANGLE' else 'rotation_euler'
                    for index in range(4 if rotation == 'rotation_axis_angle' else 3):
                        if rotation == 'rotation_axis_angle' or not bone.lock_rotation[index]:
                            yield bone, rotation, index
        for key in bone.keys():
            if isinstance(bone[key], (int, float)):
                # Blend/hand/follow states remain keyed even when target transforms are inactive.
                if name in inactive and key not in ('ik_blend', 'hand', 'follow'):
                    continue
                yield bone, '["' + bpy.utils.escape_identifier(key) + '"]', -1


def keying_poll(self, context):
    return context.mode == 'POSE' and active_rig(context) is not None


def keying_iterator(self, context, keyset):
    self.generate(context, keyset, active_rig(context))


def keying_generate(self, context, keyset, rig):
    for bone, channel, index in keyed_channels(rig, self.group_name):
        keyset.paths.add(rig, bone.path_from_id() + channel if channel.startswith('[')
                         else bone.path_from_id(channel), index=index,
                         group_method='NAMED', group_name=bone.name)


class WELTALL_OT_select_group(bpy.types.Operator):
    bl_idname = 'weltall.select_group'
    bl_label = 'Select Weltall Controls'
    bl_description = 'Select the saved whole-body or limb control group'
    bl_options = {'REGISTER', 'UNDO'}
    group: StringProperty()

    @classmethod
    def poll(cls, context):
        return context.mode == 'POSE' and active_rig(context) is not None

    def execute(self, context):
        rig = active_rig(context)
        names = set(group_bones(rig, self.group))
        for bone in rig.pose.bones:
            bone.select = bone.name in names
        if names:
            rig.data.bones.active = rig.data.bones[sorted(names)[0]]
        return {'FINISHED'}


class WELTALL_OT_key_group(bpy.types.Operator):
    bl_idname = 'weltall.key_group'
    bl_label = 'Key Weltall Controls'
    bl_description = 'Key relevant editable channels, hand states, blends, and following'
    bl_options = {'REGISTER', 'UNDO'}
    group: StringProperty()

    @classmethod
    def poll(cls, context):
        return context.mode == 'POSE' and active_rig(context) is not None

    def execute(self, context):
        identifier = dict(GROUPS)[self.group]
        result = bpy.ops.anim.keyframe_insert(type='WELTALL_' + identifier)
        return result


def _key_follow_pose(rig, bone, property_name, frame):
    # RNA key insertion accepts scene time and handles NLA Tweak Mode remapping.
    for axis, locked in enumerate(bone.lock_location):
        if not locked:
            bone.keyframe_insert('location', index=axis, frame=frame, group=bone.name)
    if not all(bone.lock_rotation):
        rotation = 'rotation_quaternion' if bone.rotation_mode == 'QUATERNION' else 'rotation_euler'
        bone.keyframe_insert(rotation, frame=frame, group=bone.name)
    bone.keyframe_insert('["' + property_name + '"]', frame=frame, group=bone.name)
    action = rig.animation_data.action
    path = bone.path_from_id() + '["' + property_name + '"]'
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    if curve.data_path == path:
                        for point in curve.keyframe_points:
                            point.interpolation = 'CONSTANT'


class WELTALL_OT_switch_follow(bpy.types.Operator):
    bl_idname = 'weltall.switch_follow'
    bl_label = 'Change Follow and Keep Pose'
    bl_description = 'Preserve this pose; key the old space one frame earlier and the new space now'
    bl_options = {'REGISTER', 'UNDO'}
    bone: StringProperty()
    value: IntProperty()

    @classmethod
    def poll(cls, context):
        return context.mode == 'POSE' and active_rig(context) is not None

    def execute(self, context):
        rig = active_rig(context)
        record = next((r for r in json.loads(rig.get('follow_controls', '[]'))
                       if r['bone'] == self.bone), None)
        if record is None or not 0 <= self.value < len(record['labels']):
            self.report({'ERROR'}, 'This control has no matching follow space')
            return {'CANCELLED'}
        bone = rig.pose.bones[self.bone]
        property_name = record['property']
        if bone[property_name] == self.value:
            return {'FINISHED'}
        scene = context.scene
        frame, subframe = scene.frame_current, scene.frame_subframe
        desired = bone.matrix.copy()
        locked_rotation = (bone.rotation_quaternion.copy() if bone.rotation_mode == 'QUATERNION'
                           else bone.rotation_euler.copy())
        locked_scale = bone.scale.copy()
        scene.frame_set(frame - 1, subframe=subframe)
        _key_follow_pose(rig, bone, property_name, frame - 1 + subframe)
        scene.frame_set(frame, subframe=subframe)
        bone[property_name] = self.value
        rig.update_tag()
        context.view_layer.update()
        bone.matrix = desired
        # A pole is a position target. Do not leave an unkeyed compensating
        # rotation on its locked channels when changing its parent orientation.
        if all(bone.lock_rotation):
            if bone.rotation_mode == 'QUATERNION':
                bone.rotation_quaternion = locked_rotation
            else:
                bone.rotation_euler = locked_rotation
        if all(bone.lock_scale):
            bone.scale = locked_scale
        rig.update_tag()
        context.view_layer.update()
        _key_follow_pose(rig, bone, property_name, frame + subframe)
        return {'FINISHED'}


class WELTALL_PT_animation(bpy.types.Panel):
    bl_label = 'Weltall Animation'
    bl_idname = 'WELTALL_PT_animation'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Weltall Rig'

    @classmethod
    def poll(cls, context):
        return active_rig(context) is not None

    def draw(self, context):
        layout = self.layout
        rig = active_rig(context)
        if context.mode != 'POSE':
            layout.label(text='Enter Pose Mode to animate.')
            return
        bone = context.active_pose_bone
        if bone and bone.name.startswith('CTRL-'):
            box = layout.box()
            box.label(text=LABELS.get(bone.name, bone.name.removeprefix('CTRL-')))
            # Wrist/ankle properties stay nearby when an associated FK/pole is selected.
            owners = [bone]
            for limb in json.loads(rig['limbs']):
                if bone.name in [*limb['fk'], limb['pole'], *limb.get('contact_controls', [])]:
                    owners.append(rig.pose.bones[limb['control']])
            for owner in owners:
                if owner != bone:
                    box.label(text=owner.name.removeprefix('CTRL-'))
                for key in owner.keys():
                    if isinstance(owner[key], (int, float)):
                        if key == 'follow':
                            continue
                        label = {'ik_blend': 'FK / IK', 'hand': 'Hand'}.get(key, key.replace('_', ' ').title())
                        box.prop(owner, '["' + bpy.utils.escape_identifier(key) + '"]',
                                 text=label, slider=key == 'ik_blend')
                if 'hand' in owner:
                    box.label(text='0 Open · 1 Closed · 2 Both · 3 Hidden')
                for follow in json.loads(rig.get('follow_controls', '[]')):
                    if follow['bone'] != owner.name:
                        continue
                    box.label(text='Change Follow (Keep Pose)')
                    row = box.row(align=True)
                    for value, label in enumerate(follow['labels']):
                        operator = row.operator('weltall.switch_follow', text=label,
                                                depress=owner[follow['property']] == value)
                        operator.bone, operator.value = owner.name, value
        layout.label(text='Select / Key Controls')
        for label, identifier in GROUPS:
            row = layout.row(align=True)
            if label != 'Selected':
                row.operator('weltall.select_group', text=label).group = label
            else:
                row.label(text=label)
            row.operator('weltall.key_group', text='Key', icon='KEY_HLT').group = label
        layout.label(text='IK blend: 0 FK · 1 IK')
        layout.label(text='Instructions: WELTALL ANIMATION GUIDE')


CLASSES = [WELTALL_OT_select_group, WELTALL_OT_key_group,
           WELTALL_OT_switch_follow, WELTALL_PT_animation]
for label, identifier in GROUPS:
    CLASSES.append(type('WELTALL_KSI_' + identifier, (bpy.types.KeyingSetInfo,), {
        'bl_idname': 'WELTALL_' + identifier,
        'bl_label': 'Weltall ' + label,
        'bl_description': 'Key active FK/IK channels and control properties',
        'group_name': label, 'poll': keying_poll,
        'iterator': keying_iterator, 'generate': keying_generate,
    }))
for cls in CLASSES:
    previous = getattr(bpy.types, cls.__name__, None)
    if previous:
        bpy.utils.unregister_class(previous)
    bpy.utils.register_class(cls)
