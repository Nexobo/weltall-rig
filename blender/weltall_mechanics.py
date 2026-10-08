"""Weltall-specific body offsets, contact pivots, and ordinary constrained spaces."""
import json

import bpy
from mathutils import Matrix, Vector


def setup_mechanics(rig):
    assert not rig.get('mechanics_revision')
    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    native = {int(i): name for i, name in json.loads(rig['native_joint_map']).items()}
    limbs = json.loads(rig['limbs'])
    rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
    parents = {b.name: b.parent.name if b.parent else None for b in rig.data.bones}
    bpy.context.view_layer.objects.active = rig
    mirror = rig.data.use_mirror_x
    rig.data.use_mirror_x = False
    bpy.ops.object.mode_set(mode='EDIT')
    bones = rig.data.edit_bones

    def bone(name, matrix, parent=None):
        b = bones.new(name)
        b.length = 0.45
        b.matrix = matrix
        b.use_deform = False
        if parent:
            b.parent = bones[parent]
        return name

    # Separate lower-body offsets retain the source channels on the native inputs.
    pelvis = bone('CTRL-pelvis', rest['CTRL-body'], native[0])
    pelvis_relays = []
    for index in (1, 8, 34):
        source = native[index]
        pivot = bone(f'MCH-pelvis-pivot-{index:03}', rest['CTRL-body'], parents[source])
        result = bone(f'MCH-pelvis-result-{index:03}', rest[source], pivot)
        for name, parent in parents.items():
            if parent == source:
                bones[name].parent = bones[result]
        pelvis_relays.append((index, source, pivot, result))

    chest = bone('CTRL-chest_pose', rest['CTRL-chest'], native[16])
    for name in ('CTRL-chest', 'CTRL-torso_armor'):
        bones[name].parent = bones[chest]

    # A space hub has references at the same rest transform. Drivers only select
    # the parent; a UI operation compensates the visible control when switching.
    spaces = []

    def space(control, options, orientation_only=False):
        hub = bone('MCH-follow-' + control[5:], rest[control])
        bones[control].parent = bones[hub]
        references = []
        for label, parent in options:
            references.append(bone('MCH-follow-' + control[5:] + '-' + label,
                                   rest[control], parent))
        spaces.append({'bone': control, 'property': 'follow',
                       'labels': [label for label, _ in options], 'hub': hub,
                       'references': references, 'orientation_only': orientation_only})

    for limb in limbs:
        space(limb['target'], [('Root', 'CTRL-root'), ('Body', native[0]), ('World', None)])
        space(limb['pole'], [('Root', 'CTRL-root'), ('Body', native[0]), ('Goal', limb['target'])])
    space('CTRL-head', [('Torso', parents['CTRL-head']), ('Root', 'CTRL-root'), ('World', None)], True)

    contacts, drivers, toe_compensations = {}, [], []
    for limb in limbs:
        side, tag = limb['name'][-1], limb['name']
        target = limb['target']
        ankle_matrix = rest[target]
        if tag.startswith('leg'):
            foot, toe, inner, outer = (6, 7, 38, 39) if side == 'L' else (13, 14, 43, 44)
            points = []
            toe_points = []
            for index in (foot, toe, inner, outer):
                obj = bpy.data.objects[f'Bone_{index:03}_Display']
                vertices = [rig.matrix_world.inverted() @ obj.matrix_world @ v.co for v in obj.data.vertices]
                points.extend(vertices)
                if index == toe:
                    toe_points = vertices
            floor = min(p.z for p in points)
            sole = [p for p in points if p.z < floor + 0.015]
            toe_sole = [p for p in toe_points if p.z < floor + 0.015]
            low, high = [Vector([fn(p[i] for p in sole) for i in range(3)]) for fn in (min, max)]
            center_x = (min(p.x for p in toe_sole) + max(p.x for p in toe_sole)) / 2
            heel = Vector((center_x, high.y, floor))
            tip = Vector((center_x, min(p.y for p in toe_sole), floor))
            ball = Vector((center_x, max(p.y for p in toe_sole), floor))
            bank = bone(f'CTRL-bank_contact.{side}', Matrix.Translation((center_x, 0, floor)), target)
            positive = bone(f'MCH-bank-positive.{side}', Matrix.Translation((high.x, high.y, floor)), target)
            negative = bone(f'MCH-bank-negative.{side}', Matrix.Translation((low.x, high.y, floor)), positive)
            drivers.extend([(positive, 'rotation_euler', 1, bank, 'rotation_euler', 1, 'max(v,0)'),
                            (negative, 'rotation_euler', 1, bank, 'rotation_euler', 1, 'min(v,0)')])
            heel_name = bone(f'CTRL-heel_contact.{side}', Matrix.Translation(heel), negative)
            tip_name = bone(f'CTRL-toe_contact.{side}', Matrix.Translation(tip), heel_name)
            ball_name = bone(f'CTRL-ball_contact.{side}', Matrix.Translation(ball), tip_name)
            goal = bone('MCH-contact-' + tag, ankle_matrix, ball_name)
            # Counter-rotate the rigid toe about the same ball contact so it can
            # stay on the ground while the heel rises. Native toe FK still adds.
            toe_control = f'CTRL-toe.{side}'
            toe_support = bone(f'MCH-toe-support.{side}', Matrix.Translation(ball), parents[toe_control])
            bones[toe_control].parent = bones[toe_support]
            toe_compensations.append((toe_support, ball_name, target))
            limb['contact_controls'] = [bank, heel_name, tip_name, ball_name]
            limb['contact_pivots'] = {'heel': list(heel), 'toe': list(tip), 'ball': list(ball),
                                      'bank_min': list(low), 'bank_max': list(high)}
        else:
            pivot = bone(f'CTRL-wrist_pivot.{side}', ankle_matrix, target)
            rotation = bone(f'CTRL-hand_contact.{side}', ankle_matrix, pivot)
            unpivot = bone(f'MCH-wrist-unpivot.{side}', ankle_matrix, rotation)
            for axis in range(3):
                drivers.append((unpivot, 'location', axis, pivot, 'location', axis, '-v'))
            goal = bone('MCH-contact-' + tag, ankle_matrix, unpivot)
            limb['contact_controls'] = [pivot, rotation]
        # Move the solver and its original-axis socket through the same contact.
        bones['MCH-axis-' + tag].parent = bones[goal]
        contacts[tag] = goal

    bpy.ops.object.mode_set(mode='OBJECT')
    rig.data.use_mirror_x = mirror

    def copy(owner, target, kind='COPY_TRANSFORMS', space='WORLD'):
        c = rig.pose.bones[owner].constraints.new(kind)
        c.target, c.subtarget = rig, target
        c.owner_space = c.target_space = space
        return c

    for index, source, pivot, result in pelvis_relays:
        for name in (f'OUT-{index:03}', f'MCH-result-{index:03}'):
            copy(name, result)
        native[index] = result
    rig['native_joint_map'] = json.dumps(native)

    for record in spaces:
        p = rig.pose.bones[record['bone']]
        p['follow'] = 0
        p.id_properties_ui('follow').update(min=0, max=len(record['labels']) - 1, default=0,
            description=' / '.join(f'{i} {s}' for i, s in enumerate(record['labels'])) + '; switch with Rig panel to preserve pose')
        if record['orientation_only']:
            copy(record['hub'], record['references'][0], 'COPY_LOCATION')
        for index, reference in enumerate(record['references']):
            c = copy(record['hub'], reference, 'COPY_ROTATION' if record['orientation_only'] else 'COPY_TRANSFORMS')
            d = c.driver_add('influence').driver
            v = d.variables.new()
            v.name, v.type = 'mode', 'SINGLE_PROP'
            v.targets[0].id, v.targets[0].data_path = rig, p.path_from_id() + '["follow"]'
            d.expression = f'mode == {index}'

    for owner, channel, axis, target, target_channel, target_axis, expression in drivers:
        d = rig.pose.bones[owner].driver_add(channel, axis).driver
        v = d.variables.new()
        v.name, v.type = 'v', 'SINGLE_PROP'
        v.targets[0].id = rig
        v.targets[0].data_path = rig.pose.bones[target].path_from_id(target_channel) + f'[{target_axis}]'
        d.expression = expression
    for owner, ball, goal in toe_compensations:
        d = rig.pose.bones[owner].driver_add('rotation_euler', 0).driver
        for name, path in (('roll', rig.pose.bones[ball].path_from_id('rotation_euler') + '[0]'),
                           ('blend', rig.pose.bones[goal].path_from_id() + '["ik_blend"]')):
            v = d.variables.new()
            v.name, v.type = name, 'SINGLE_PROP'
            v.targets[0].id, v.targets[0].data_path = rig, path
        d.expression = '-roll * blend'

    old_names = set(rest)
    mechanism = rig.data.collections['Mechanism']
    for p in rig.pose.bones:
        if p.name not in old_names:
            p.rotation_mode = 'XYZ'
            p.lock_scale = (True,) * 3
            p.lock_location = (True,) * 3
            if p.name.startswith('MCH-'):
                mechanism.assign(p.bone)
                p.bone.hide_select = True
            elif p.name == pelvis or 'wrist_pivot' in p.name:
                p.lock_location = (False,) * 3
            if 'wrist_pivot' in p.name:
                p.lock_rotation = (True,) * 3
            elif 'bank_contact' in p.name:
                p.lock_rotation = (True, False, True)
            elif 'ball_contact' in p.name:
                p.lock_rotation = (False, True, True)
            elif any(s in p.name for s in ('heel_contact', 'toe_contact')):
                p.lock_rotation = (False, True, False)
    # Raw basis channels are intentional: LOCAL Copy Transforms also converts
    # between rest-parent frames, which would rotate these inserted offset bones.
    for _, source, pivot, result in pelvis_relays:
        for owner, target in ((pivot, pelvis), (result, source)):
            p, q = rig.pose.bones[owner], rig.pose.bones[target]
            p.rotation_mode = q.rotation_mode
            rotation = 'rotation_quaternion' if q.rotation_mode == 'QUATERNION' else 'rotation_euler'
            for channel in ('location', rotation, 'scale'):
                for axis in range(len(getattr(q, channel))):
                    d = p.driver_add(channel, axis).driver
                    v = d.variables.new()
                    v.name, v.type = 'v', 'SINGLE_PROP'
                    v.targets[0].id = rig
                    v.targets[0].data_path = q.path_from_id(channel) + f'[{axis}]'
                    d.expression = 'v'
    for limb in limbs:
        solver = rig.pose.bones[limb['mch'][1]].constraints[0]
        solver.subtarget = contacts[limb['name']]
        limb['solver_target'] = contacts[limb['name']]
    rig['limbs'] = json.dumps(limbs)
    rig['follow_controls'] = json.dumps([{k: v for k, v in r.items() if k not in ('hub', 'references')}
                                       for r in spaces])
    rig['mechanics_revision'] = 1
    rig.update_tag()
    bpy.context.view_layer.update()
    return {'pelvis': pelvis, 'chest': chest, 'spaces': len(spaces), 'contacts': contacts}
