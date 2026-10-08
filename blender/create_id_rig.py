"""Build Weltall or Id mechanical controls with the complete Weltall reference library."""
import bisect
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector, Euler

sys.path.insert(0, str(Path(__file__).parent))
from id_hand_swaps import initialize_hand_swaps, source_hand_nodes, source_hand_state, AMBIGUOUS_STATES
from id_holo_wings import initialize_holo_wings
from animation_dedup import deduplicate_actions
from rig_pose_tools import prepare_pose_controls, pose_instructions

arguments = sys.argv[sys.argv.index('--') + 1:]
family, destination = [Path(s).resolve() for s in arguments[:2]]
model_id = arguments[2] if len(arguments) == 3 else 'weltall-id'
assert model_id in ('weltall', 'weltall-id')
native_weltall = model_id == 'weltall'
label = 'Weltall' if native_weltall else 'Weltall-Id'
assert not destination.exists(), f'Output already exists: {destination}'
id_folder, source_folder = family / model_id, family / 'weltall'
id_manifest = json.loads((id_folder / 'model.json').read_text())
source_manifest = json.loads((source_folder / 'model.json').read_text())
assert id_manifest['model']['id'] == model_id
assert source_manifest['model']['id'] == 'weltall'
reference_bytes = (source_folder / 'reference.glb').read_bytes()
assert hashlib.sha256(reference_bytes).hexdigest() == source_manifest['reference']['sha256']


def read_glb(raw):
    length, kind = struct.unpack_from('<II', raw, 12)
    assert kind == 0x4E4F534A
    document = json.loads(raw[20:20 + length])
    size, kind = struct.unpack_from('<II', raw, 20 + length)
    assert kind == 0x004E4942
    return document, raw[28 + length:28 + length + size]


source, binary = read_glb(reference_bytes)
source_rest, _ = read_glb((source_folder / 'edit.glb').read_bytes())
source_nodes = source['nodes']
assert [n['name'] for n in source_nodes] == [n['name'] for n in source_rest['nodes']]
source_indices = {int(n['extras']['sourceNodeIndex']): i for i, n in enumerate(source_nodes)
                  if n.get('extras', {}).get('transformRole') == 'model-local-bone'}
source_parents = {c: i for i, n in enumerate(source_nodes) for c in n.get('children', [])}
conversion = Matrix.Rotation(math.pi / 2, 4, 'X')  # glTF Y-up to Blender Z-up.
accessors = {}


def accessor(index):
    if index not in accessors:
        a = source['accessors'][index]
        v = source['bufferViews'][a['bufferView']]
        assert a['componentType'] == 5126 and not v.get('byteStride')
        width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
        offset = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        accessors[index] = np.frombuffer(binary, dtype='<f4', count=a['count'] * width,
                                        offset=offset).reshape(a['count'], width)
    return accessors[index]


def sample(times, values, t, rotation=False, step=False):
    right = bisect.bisect_right(times, t + (1e-7 if native_weltall else 0))
    if right == 0:
        return values[0]
    if right >= len(times) or step:
        return values[min(right - 1, len(times) - 1)]
    left = right - 1
    alpha = (t - times[left]) / (times[right] - times[left])
    if native_weltall:
        alpha = max(0.0, min(1.0, float(alpha)))
    if rotation:
        a, b = values[left], values[right]
        q = Quaternion((a[3], a[0], a[1], a[2])).slerp(
            Quaternion((b[3], b[0], b[1], b[2])), float(alpha))
        return (q.x, q.y, q.z, q.w)
    return values[left] * (1 - alpha) + values[right] * alpha


def source_world(channels=(), t=0):
    trs = [[n.get('translation', (0, 0, 0)), n.get('rotation', (0, 0, 0, 1)),
            n.get('scale', (1, 1, 1))] for n in source_rest['nodes']]
    for node, path, times, values, interpolation in channels:
        trs[node][{'translation': 0, 'rotation': 1, 'scale': 2}[path]] = sample(
            times, values, t, path == 'rotation', interpolation == 'STEP')
    world = []
    for i, (loc, rot, scale) in enumerate(trs):
        local = Matrix.LocRotScale(Vector(loc), Quaternion((rot[3], rot[0], rot[1], rot[2])),
                                  Vector(scale))
        world.append((world[source_parents[i]] if i in source_parents else conversion) @ local)
    return world, trs


source_bind, _ = source_world()
bpy.ops.wm.read_homefile(use_factory_startup=True, use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(id_folder / 'edit.glb'))
scene = bpy.context.scene
scene.render.fps = 30
scene['gear_id'] = model_id
scene['editing_frame'] = 1
scene['custom_gear_rig' if native_weltall else 'custom_id_rig'] = 1
original = list(scene.objects)
bpy.context.view_layer.update()
original_basis = {o.name: [list(row) for row in o.matrix_basis] for o in original}
transform_text = bpy.data.texts.new('ORIGINAL MODEL TRANSFORMS')
transform_text.write(json.dumps(original_basis))
joint_objects = {int(o['sourceNodeIndex']): o for o in original
                 if o.get('transformRole') == 'model-local-bone'}
assert len(joint_objects) == (51 if native_weltall else 61)
parents = {i: (int(o.parent['sourceNodeIndex']) if o.parent.get('transformRole') == 'model-local-bone'
               else None) for i, o in joint_objects.items()}
model_scale = joint_objects[0].matrix_world.to_scale().x
unit_scale = 1.0  # Keep the animator's armature in physical Blender units with applied scale.
bind = {i: Matrix.LocRotScale(o.matrix_world.translation / unit_scale,
                             o.matrix_world.to_quaternion(), Vector((1, 1, 1)))
        for i, o in joint_objects.items()}
local_bind = {i: (bind[parents[i]].inverted() if parents[i] is not None else Matrix.Identity(4)) @ m
              for i, m in bind.items()}

# Map anatomical joints, not numeric node IDs. Unmapped Id joints retain their local rest pose.
mapping = {0: 0, 1: 15, 2: 16, 3: 17, 4: 24, 7: 25, 8: 26, 9: 27, 10: 28,
           11: 24, 12: 18, 15: 19, 16: 20, 17: 21, 18: 22, 19: 18, 20: 30, 21: 31,
           22: 33, 23: 50, 24: 32, 25: 49, 26: 34, 27: 35, 28: 36, 29: 1, 31: 2,
           32: 4, 33: 4, 34: 5, 35: 6, 36: 8, 38: 9, 39: 11, 40: 11, 41: 12, 42: 13,
           43: 47, 44: 48, 46: 46, 47: 45, 55: 37, 56: 40, 57: 7, 58: 41, 59: 42, 60: 14}
names = {0: 'body', 1: 'hips', 2: 'spine', 3: 'chest', 4: 'clavicle.R', 7: 'upper_arm.R',
         8: 'forearm.R', 9: 'hand_fk.R', 10: 'palm.R', 11: 'shoulder_armor.R',
         12: 'clavicle.L', 15: 'upper_arm.L', 16: 'forearm.L', 17: 'hand_fk.L',
         18: 'palm.L', 19: 'shoulder_armor.L', 21: 'head', 22: 'wing_root.L',
         23: 'wing_panel.L', 24: 'wing_root.R', 25: 'wing_panel.R', 27: 'skirt.R',
         28: 'skirt.L', 31: 'thigh.L', 32: 'shin.L', 34: 'ankle_fk.L', 35: 'foot.L',
         38: 'thigh.R', 39: 'shin.R', 41: 'ankle_fk.R', 42: 'foot.R',
         45: 'shoulder_fin.R', 48: 'shoulder_fin.L', 49: 'wing_lower.L',
         50: 'wing_middle.L', 51: 'wing_upper.L', 52: 'wing_middle.R',
         53: 'wing_upper.R', 54: 'wing_lower.R', 57: 'toe.L', 60: 'toe.R'}
if native_weltall:
    mapping = {i: i for i in bind}
    names = {0: 'body', 15: 'hips', 16: 'spine', 17: 'chest', 18: 'clavicle.L',
             19: 'upper_arm.L', 20: 'forearm.L', 21: 'hand_fk.L',
             24: 'clavicle.R', 25: 'upper_arm.R', 26: 'forearm.R', 27: 'hand_fk.R',
             2: 'thigh.L', 4: 'shin.L', 5: 'ankle_fk.L', 6: 'foot.L', 7: 'toe.L',
             9: 'thigh.R', 11: 'shin.R', 12: 'ankle_fk.R', 13: 'foot.R', 14: 'toe.R',
             30: 'torso_armor', 31: 'head', 33: 'wing_root.L', 32: 'wing_root.R',
             50: 'wing_panel.L', 49: 'wing_panel.R', 36: 'skirt.L', 35: 'skirt.R',
             37: 'thigh_armor.L', 41: 'thigh_armor.R', 3: 'knee_armor.L', 10: 'knee_armor.R',
             40: 'shin_armor.L', 42: 'shin_armor.R',
             45: 'upper_arm_armor.L', 48: 'upper_arm_armor.R',
             46: 'forearm_armor.L', 47: 'forearm_armor.R',
             38: 'foot_inner.L', 39: 'foot_outer.L', 43: 'foot_inner.R', 44: 'foot_outer.R'}
fk = {i: ('CTRL-' + names[i] if i in names else f'MCH-fk-{i:03}') for i in bind}
out = {i: f'OUT-{i:03}' for i in bind}
ik_result = {i: f'MCH-result-{i:03}' for i in bind}
data = bpy.data.armatures.new(label + ' mechanical rig')
rig = bpy.data.objects.new(label + ' RIG', data)
scene['control_rig'] = rig.name
scene.collection.objects.link(rig)
rig.matrix_world = Matrix.Scale(unit_scale, 4)
rig.show_in_front = True
rig['model'] = label
rig['reference_clips'] = len(source['animations'])
rig['original_joint_map'] = json.dumps(fk)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')


def bone(name, matrix, parent=None, length=None):
    b = data.edit_bones.new(name)
    b.length = 100 * model_scale if length is None else length
    b.matrix = matrix
    b.use_deform = False
    if parent:
        b.parent = data.edit_bones[parent]
    return b


bone('CTRL-root', Matrix.Identity(4), length=400 * model_scale)
for i in bind:
    bone(fk[i], bind[i], fk[parents[i]] if parents[i] is not None else 'CTRL-root')
    bone(out[i], bind[i], out[parents[i]] if parents[i] is not None else 'CTRL-root')
    bone(ik_result[i], bind[i], ik_result[parents[i]] if parents[i] is not None else 'CTRL-root')
# Foot and toe rings follow the evaluated ankle while retaining their local FK rotations.
for foot, ankle in (((6, 5), (13, 12)) if native_weltall else ((35, 34), (42, 41))):
    assert parents[foot] == ankle
    data.edit_bones[fk[foot]].parent = data.edit_bones[out[ankle]]
if not native_weltall:
    back_control = bind[20].copy()
    back_control.translation = (bind[22].translation + bind[24].translation) / 2
    bone('CTRL-holo_wings', back_control, out[20])

limbs = [{'name': 'arm.R', 'joints': [7, 8, 9], 'parent': 6},
         {'name': 'arm.L', 'joints': [15, 16, 17], 'parent': 14},
         {'name': 'leg.L', 'joints': [31, 32, 34], 'parent': 30},
         {'name': 'leg.R', 'joints': [38, 39, 41], 'parent': 37}]
if native_weltall:
    limbs = [{'name': 'arm.R', 'joints': [25, 26, 27], 'parent': 24},
             {'name': 'arm.L', 'joints': [19, 20, 21], 'parent': 18},
             {'name': 'leg.L', 'joints': [2, 4, 5], 'parent': 1},
             {'name': 'leg.R', 'joints': [9, 11, 12], 'parent': 8}]


def pole_position(a, b, c, distance, arm):
    line = c - a
    direction = Vector((0, 1 if arm else -1, 0))
    direction -= line.normalized() * direction.dot(line.normalized())
    return b + direction.normalized() * distance


for limb in limbs:
    tag = limb['name']
    a, b, c = [bind[i].translation for i in limb['joints']]
    limb['target'] = 'CTRL-' + ('hand_ik.' if tag.startswith('arm') else 'foot_ik.') + tag[-1]
    limb['control'] = limb['target']
    limb['pole'] = 'CTRL-' + ('elbow.' if tag.startswith('arm') else 'knee.') + tag[-1]
    limb['switch'] = tag.replace('.', '_') + '_ik'
    limb['fk'] = [fk[i] for i in limb['joints']]
    limb['out'] = [out[i] for i in limb['joints']]
    limb['length'] = (b - a).length + (c - b).length
    bone(limb['target'], bind[limb['joints'][2]], 'CTRL-root', length=200 * model_scale)
    pole = Matrix.Translation(pole_position(a, b, c, limb['length'] * 0.6, tag.startswith('arm')))
    bone(limb['pole'], pole, 'CTRL-root')
    limb['mch'] = []
    for j, (head, tail) in enumerate(((a, b), (b, c))):
        name = f'MCH-ik-{tag}-{j}'
        mch = bone(name, Matrix.Identity(4), out[limb['parent']] if j == 0 else limb['mch'][0])
        mch.head, mch.tail = head, tail
        if j == 1:
            mch.use_connect = True
        mch.align_roll(Vector((0, 1 if tag.startswith('arm') else -1, 0)))
        limb['mch'].append(name)
        # A socket converts the solver's Y-aligned axes back to the original game axes.
        bone(f'MCH-socket-{tag}-{j}', bind[limb['joints'][j]], name)
    bone(f'MCH-end-{tag}', bind[limb['joints'][2]], limb['mch'][1])

if native_weltall:
    from weltall_native_rig import initialize_native_visibility, setup_native_visibility, key_native_visibility
    initialize_native_visibility(rig, original, bone)
    placement = next(o for o in original if o.get('transformRole') == 'external-placement')
    placement_bind = Matrix.LocRotScale(placement.matrix_world.translation,
                                       placement.matrix_world.to_quaternion(), Vector((1, 1, 1)))
    bone('MCH-placement', placement_bind, 'CTRL-root')
bpy.ops.object.mode_set(mode='OBJECT')
collections = {n: data.collections.new(n) for n in ('Body', 'FK arms', 'FK legs', 'IK', 'Wings', 'Armor', 'Mechanism')}
collections['Mechanism'].is_visible = False
widgets = bpy.data.collections.new('Rig shapes')
scene.collection.children.link(widgets)
widgets.hide_render = True


def shape(name, kind):
    mesh = bpy.data.meshes.new(name)
    if kind == 'box':
        verts = [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
        edges = [(a, b) for a in range(8) for b in range(a + 1, 8)
                 if sum(verts[a][i] != verts[b][i] for i in range(3)) == 1]
    elif kind == 'diamond':
        verts = [(1, 0, 0), (0, 1, 0), (-1, 0, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
        edges = [(i, (i + 1) % 4) for i in range(4)] + [(i, j) for i in range(4) for j in (4, 5)]
    else:
        verts = [(math.cos(i * math.tau / 32), math.sin(i * math.tau / 32), 0) for i in range(32)]
        edges = [(i, (i + 1) % 32) for i in range(32)]
        if kind == 'sphere':
            for plane in (1, 2):
                offset = len(verts)
                verts += [(0, x, y) if plane == 1 else (x, 0, y) for x, y, _ in verts[:32]]
                edges += [(offset + i, offset + (i + 1) % 32) for i in range(32)]
    mesh.from_pydata(verts, edges, [])
    obj = bpy.data.objects.new(name, mesh)
    widgets.objects.link(obj)
    obj.hide_render = True
    obj.hide_set(True)
    return obj


ring, box, diamond = [shape('WGT-' + k, k) for k in ('ring', 'box', 'diamond')]
for pb in rig.pose.bones:
    pb.rotation_mode = 'QUATERNION'
    pb.lock_scale = (True, True, True)
    pb.lock_location = (True, True, True)
    if pb.name.startswith(('OUT-', 'MCH-')) or pb.name in ('CTRL-palm.L', 'CTRL-palm.R'):
        collections['Mechanism'].assign(pb.bone)
        continue
    name = pb.name
    group = ('IK' if '_ik.' in name or 'elbow.' in name or 'knee.' in name else
             'Wings' if 'wing_' in name or name == 'CTRL-holo_wings' else 'Armor' if any(s in name for s in ('armor', 'fin', 'skirt', 'palm', 'toe', 'foot.')) else
             'FK arms' if any(s in name for s in ('arm.', 'hand_fk', 'clavicle')) else
             'FK legs' if any(s in name for s in ('thigh', 'shin', 'ankle')) else 'Body')
    collections[group].assign(pb.bone)
    pb.custom_shape = diamond if 'elbow.' in name or 'knee.' in name else box if group == 'IK' or name == 'CTRL-holo_wings' else ring
    pb.use_custom_shape_bone_size = False
    size = {'CTRL-root': 600, 'CTRL-body': 420, 'CTRL-hips': 280, 'CTRL-chest': 240}.get(name, 180 if group == 'IK' else 110)
    pb.custom_shape_scale_xyz = (size * model_scale,) * 3
    pb.color.palette = 'THEME04' if name.endswith('.L') else 'THEME01' if name.endswith('.R') else 'THEME03'
    if group == 'IK' or name in ('CTRL-root', 'CTRL-body', 'CTRL-hips'):
        pb.lock_location = (False, False, False)
    if 'elbow.' in name or 'knee.' in name:
        pb.lock_rotation = (True, True, True)
    if name == 'CTRL-holo_wings':
        pb.lock_rotation = (True, True, True)


def copy_transforms(owner, target, subtarget, space='WORLD'):
    constraint = owner.constraints.new('COPY_TRANSFORMS')
    constraint.target, constraint.subtarget = target, subtarget
    constraint.owner_space = constraint.target_space = space
    return constraint


for i, obj in joint_objects.items():
    copy_transforms(rig.pose.bones[out[i]], rig, fk[i], 'LOCAL')
    copy_transforms(rig.pose.bones[ik_result[i]], rig, fk[i], 'LOCAL')
    constraint = copy_transforms(obj, rig, out[i])
    constraint.name = 'Id rig output COPY_TRANSFORMS'
    # Copy the complete orientation matrix without an Euler conversion, then
    # retain the original embedded model scale for the rigid mesh vertices.
    scale = obj.constraints.new('COPY_SCALE')
    scale.target = joint_objects[0].parent
    scale.owner_space = scale.target_space = 'WORLD'
    scale.name = 'Id rig output COPY_SCALE'
    if native_weltall:
        scale.use_offset = True
if native_weltall:
    copy_transforms(placement, rig, 'MCH-placement').name = 'Gear rig output placement'
    scale = placement.constraints.new('COPY_SCALE')
    scale.name = 'Gear rig output placement scale'
    scale.target = placement.parent
    scale.owner_space = scale.target_space = 'WORLD'
    scale.use_offset = True
for limb in limbs:
    settings = rig.pose.bones[limb['control']]
    settings[limb['switch']] = 0.0
    settings.id_properties_ui(limb['switch']).update(min=0.0, max=1.0, description='0 = FK / reference, 1 = IK')
    lower = rig.pose.bones[limb['mch'][1]]
    # A small bend keeps Blender's IK solver out of the exactly straight singularity.
    lower.rotation_quaternion = Quaternion((1, 0, 0), 0.1)
    ik = lower.constraints.new('IK')
    ik.target, ik.subtarget = rig, limb['target']
    ik.pole_target, ik.pole_subtarget = rig, limb['pole']
    ik.chain_count = 2
    ik.use_stretch = False
    ik.iterations = 100
    end_rotation = rig.pose.bones[f'MCH-end-{limb["name"]}'].constraints.new('COPY_ROTATION')
    end_rotation.target, end_rotation.subtarget = rig, limb['target']
    end_rotation.owner_space = end_rotation.target_space = 'WORLD'
    for j, i in enumerate(limb['joints']):
        subtarget = f'MCH-socket-{limb["name"]}-{j}' if j < 2 else f'MCH-end-{limb["name"]}'
        # Convert solver orientation into the native hierarchy before blending.
        solved = rig.pose.bones[ik_result[i]].constraints.new('COPY_ROTATION')
        solved.target, solved.subtarget = rig, subtarget
        solved.owner_space = solved.target_space = 'WORLD'
        constraint = rig.pose.bones[out[i]].constraints.new('COPY_ROTATION')
        constraint.target, constraint.subtarget = rig, ik_result[i]
        constraint.owner_space = constraint.target_space = 'LOCAL'
        driver = constraint.driver_add('influence').driver
        variable = driver.variables.new()
        variable.name = 'ik'
        variable.type = 'SINGLE_PROP'
        variable.targets[0].id = rig
        variable.targets[0].data_path = settings.path_from_id() + f'["{limb["switch"]}"]'
        driver.expression = 'ik'
    rig.pose.bones[limb['mch'][0]].ik_stretch = 0
    lower.ik_stretch = 0
rig['limbs'] = json.dumps(limbs)
holo_wings = [] if native_weltall else initialize_holo_wings(rig, joint_objects)
editable = original + holo_wings

# Join coincident vertices without changing triangle order, UV corners, materials, or split normals.
weld_report = []
for mesh in {o.data for o in editable if o.type == 'MESH'}:
    vertex_map, verts, remap = {}, [], []
    for vertex in mesh.vertices:
        key = tuple(vertex.co)
        if key not in vertex_map:
            vertex_map[key] = len(verts)
            verts.append(key)
        remap.append(vertex_map[key])
    faces = [[remap[v] for v in p.vertices] for p in mesh.polygons]
    assert all(len(set(face)) == len(face) for face in faces), f'Degenerate source face in {mesh.name}'
    normals = [n.vector.copy() for n in mesh.corner_normals]
    clean = bpy.data.meshes.new(mesh.name + ' welded')
    clean.from_pydata(verts, [], faces)
    for material in mesh.materials:
        clean.materials.append(material)
    for old, new in zip(mesh.polygons, clean.polygons):
        new.material_index = old.material_index
        new.use_smooth = True
    for layer in mesh.uv_layers:
        new = clean.uv_layers.new(name=layer.name)
        values = np.empty(len(layer.data) * 2, dtype=np.float32)
        layer.data.foreach_get('uv', values)
        new.data.foreach_set('uv', values)
    if native_weltall:
        # Keep the source's separate triangle normal fans after welding positions.
        for edge in clean.edges:
            edge.use_edge_sharp = True
        clean.update()
    clean.normals_split_custom_set(normals)
    weld_report.append({'mesh': mesh.name, 'before': len(mesh.vertices), 'after': len(clean.vertices),
                        'triangles': len(clean.polygons)})
    for obj in editable:
        if obj.type == 'MESH' and obj.data == mesh:
            obj.data = clean

for obj in editable:
    obj.lock_location = obj.lock_rotation = obj.lock_scale = (True, True, True)

hands = setup_native_visibility(rig, original) if native_weltall else initialize_hand_swaps(rig, joint_objects, original)
hand_nodes = source_hand_nodes(source)


def new_action(name):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    slot = action.slots.new(id_type='OBJECT', name=rig.name)
    strip = action.layers.new('Pose').strips.new(type='KEYFRAME')
    return action, slot, strip.channelbag(slot, ensure=True)


def curve(bag, path, values, frame_numbers, group, constant=False):
    values = np.asarray(values, dtype=np.float32)
    if values.ndim == 1:
        values = values[:, None]
    for axis in range(values.shape[1]):
        fc = bag.fcurves.new(path, index=axis, group_name=group)
        fc.keyframe_points.add(len(values))
        fc.keyframe_points.foreach_set('co', np.column_stack((frame_numbers, values[:, axis])).ravel())
        for key in fc.keyframe_points:
            key.interpolation = 'CONSTANT' if constant else 'LINEAR'
        fc.update()


animation_data = rig.animation_data_create()
rest_action, rest_slot, bag = new_action('REST POSE - ' + label)
for pb in rig.pose.bones:
    if pb.name not in fk.values():
        continue
    for channel in ('location', 'rotation_quaternion', 'scale'):
        curve(bag, pb.path_from_id(channel), [tuple(getattr(pb, channel))] * 2, (1, 2), pb.name)
for hand in ([] if native_weltall else hands):
    control = rig.pose.bones[hand['control']]
    state = control[hand['property']]
    curve(bag, control.path_from_id() + f'["{hand["property"]}"]', (state, state), (1, 2), 'Hands', True)
if native_weltall:
    for channel in ('location', 'rotation_quaternion', 'scale'):
        curve(bag, rig.pose.bones['CTRL-root'].path_from_id(channel),
              [tuple(getattr(rig.pose.bones['CTRL-root'], channel))] * 2, (1, 2), 'CTRL-root')
    key_native_visibility(bag, curve, (1, 2), [source_world()[1]] * 2, source_nodes, hands, rig)
track = animation_data.nla_tracks.new()
track.name = 'Reference animations'
rest_strip = track.strips.new(rest_action.name, 1, rest_action)
rest_strip.action_slot = rest_slot
rest_strip.extrapolation = 'HOLD_FORWARD'
scene.timeline_markers.new('REST POSE - edit here', frame=1)
root_ratio = bind[0].translation.z * unit_scale / source_bind[source_indices[0]].translation.z
rotation_offsets = {i: source_bind[source_indices[s]].to_quaternion().inverted() @ bind[i].to_quaternion()
                    for i, s in mapping.items()}
cursor, schedule, maximum_joint_error = 31, [], 0.0

for clip_index, clip in enumerate(source['animations']):
    channels = []
    for channel in clip['channels']:
        sampler = clip['samplers'][channel['sampler']]
        assert sampler.get('interpolation', 'LINEAR') in ('LINEAR', 'STEP')
        channels.append((channel['target']['node'], channel['target']['path'],
                         accessor(sampler['input'])[:, 0], accessor(sampler['output']),
                         sampler.get('interpolation', 'LINEAR')))
    seconds = max(float(c[2][-1]) for c in channels)
    count = max(2, round(seconds * 30) + 1)
    frames = np.arange(1, count + 1, dtype=np.float32)
    rotations = {i: np.empty((count, 4), dtype=np.float32) for i in bind}
    root_locations = np.empty((count, 3), dtype=np.float32)
    if native_weltall:
        locations = {i: np.empty((count, 3), dtype=np.float32) for i in bind}
        scales = {i: np.empty((count, 3), dtype=np.float32) for i in bind}
        root_rotations, root_scales = np.empty((count, 4), dtype=np.float32), np.empty((count, 3), dtype=np.float32)
        visibility_frames = []
    hand_states = {side: np.empty(count, dtype=np.float32) for side in ('L', 'R')}
    previous = {}
    for frame in range(count):
        world, trs = source_world(channels, min(seconds, frame / 30))
        if native_weltall:
            placement_index = next(j for j, n in enumerate(source_nodes)
                                   if n.get('extras', {}).get('transformRole') == 'external-placement')
            root_pose = world[placement_index] @ source_bind[placement_index].inverted()
            root_loc, root_rot, root_scale = root_pose.decompose()
            if 'root' in previous and root_rot.dot(previous['root']) < 0:
                root_rot.negate()
            previous['root'] = root_rot
            root_locations[frame], root_rotations[frame], root_scales[frame] = root_loc, root_rot, root_scale
            visibility_frames.append(trs)
        else:
            for side, state in source_hand_state(trs, hand_nodes, clip['name']).items():
                hand_states[side][frame] = state
        pose = {}
        for i in bind:
            if native_weltall:
                parent_pose = pose[parents[i]] if parents[i] is not None else root_pose
                pose[i] = world[source_indices[i]] @ conversion.inverted() @ Matrix.Scale(1 / model_scale, 4)
            else:
                parent_pose = pose[parents[i]] if parents[i] is not None else Matrix.Identity(4)
                rotation = (world[source_indices[mapping[i]]].to_quaternion() @ rotation_offsets[i]
                            if i in mapping else parent_pose.to_quaternion() @ local_bind[i].to_quaternion())
                location = parent_pose @ local_bind[i].translation
                if i == 0:
                    delta = world[source_indices[0]].translation - source_bind[source_indices[0]].translation
                    location = bind[0].translation + delta * (root_ratio / unit_scale)
                pose[i] = Matrix.LocRotScale(location, rotation, Vector((1, 1, 1)))
            local_pose = parent_pose.inverted() @ pose[i]
            basis = local_bind[i].inverted() @ local_pose
            q = basis.to_quaternion()
            if i in previous and q.dot(previous[i]) < 0:
                q.negate()
            previous[i] = q
            rotations[i][frame] = tuple(q)
            if native_weltall:
                locations[i][frame], scales[i][frame] = basis.translation, basis.to_scale()
            elif i == 0:
                root_locations[frame] = basis.translation
            else:
                maximum_joint_error = max(maximum_joint_error, basis.translation.length * unit_scale)
    action, slot, bag = new_action('Weltall/' + clip['name'])
    action['reference_only'] = True
    action['source_clip'] = clip['name']
    action['partial_source_data'] = 'PARTIAL' in clip['name']
    for i in bind:
        curve(bag, rig.pose.bones[fk[i]].path_from_id('rotation_quaternion'), rotations[i], frames, fk[i])
    if native_weltall:
        for i in bind:
            curve(bag, rig.pose.bones[fk[i]].path_from_id('location'), locations[i], frames, fk[i])
            curve(bag, rig.pose.bones[fk[i]].path_from_id('scale'), scales[i], frames, fk[i])
        for channel, values in (('location', root_locations), ('rotation_quaternion', root_rotations), ('scale', root_scales)):
            curve(bag, rig.pose.bones['CTRL-root'].path_from_id(channel), values, frames, 'CTRL-root')
        key_native_visibility(bag, curve, frames, visibility_frames, source_nodes, hands, rig)
    else:
        curve(bag, rig.pose.bones[fk[0]].path_from_id('location'), root_locations, frames, fk[0])
        for hand in hands:
            control = rig.pose.bones[hand['control']]
            curve(bag, control.path_from_id() + f'["{hand["property"]}"]', hand_states[hand['side']], frames, 'Hands', True)
    strip = track.strips.new(action.name, cursor, action)
    strip.action_slot = slot
    strip.action_frame_start, strip.action_frame_end = 1, count
    strip.frame_start, strip.frame_end = cursor, cursor + count - 1
    strip.extrapolation = 'NOTHING'
    strip.blend_type = 'REPLACE'
    strip.blend_in = strip.blend_out = 0
    scene.timeline_markers.new(clip['name'], frame=cursor)
    schedule.append({'source': clip['name'], 'action': action.name, 'start': cursor,
                     'end': cursor + count - 1, 'samples': count})
    cursor += count
    if clip_index % 20 == 0:
        print(f'RETARGET {clip_index + 1}/{len(source["animations"])}', flush=True)

assert maximum_joint_error < 0.0001, f'Retarget changed joint spacing: {maximum_joint_error}'
scene.frame_start, scene.frame_end = 1, cursor - 1
scene.frame_set(1)
bpy.context.view_layer.update()
# Calibrate the solver angle with a bent limb; keep the poles on their bend sides.
for limb in limbs:
    solver = rig.pose.bones[limb['mch'][1]].constraints[0]
    target = rig.pose.bones[limb['target']]
    neutral = target.matrix_basis.copy()
    a, b, c = [bind[i].translation for i in limb['joints']]
    matrix = target.matrix.copy()
    matrix.translation = a + (c - a) * 0.85
    target.matrix = matrix
    solver.pole_angle = 0
    bpy.context.view_layer.update()
    axis = (matrix.translation - a).normalized()
    desired = rig.pose.bones[limb['pole']].matrix.translation - a
    desired -= axis * desired.dot(axis)
    actual = rig.pose.bones[limb['mch'][1]].matrix.translation - a
    actual -= axis * actual.dot(axis)
    angle = math.atan2(axis.dot(actual.cross(desired)), actual.dot(desired))
    best = (float('inf'), 0.0)
    for candidate in (angle, -angle):
        solver.pole_angle = candidate
        bpy.context.view_layer.update()
        actual = rig.pose.bones[limb['mch'][1]].matrix.translation - a
        actual -= axis * actual.dot(axis)
        error = (actual.normalized() - desired.normalized()).length
        if error < best[0]:
            best = error, solver.pole_angle
    solver.pole_angle = best[1]
    assert best[0] < 0.001, f'Pole calibration failed: {limb["name"]} {best[0]}'
    target.matrix_basis = neutral
bpy.context.view_layer.update()
# The solver's calibrated roll is a fixed mechanism offset. Convert its neutral
# orientation to the original game axes so clean IK does not twist the armor.
socket_bind = {}
for limb in limbs:
    for j in (0, 1):
        mch = rig.pose.bones[limb['mch'][j]]
        rotation = (mch.bone.matrix_local.inverted() @ mch.matrix).to_quaternion()
        twist = Quaternion((rotation.w, 0, rotation.y, 0)).normalized()
        socket_bind[f'MCH-socket-{limb["name"]}-{j}'] = (
            mch.bone.matrix_local @ twist.inverted().to_matrix().to_4x4() @
            mch.bone.matrix_local.inverted() @ bind[limb['joints'][j]])
bpy.ops.object.mode_set(mode='EDIT')
for name, matrix in socket_bind.items():
    data.edit_bones[name].matrix = matrix
bpy.ops.object.mode_set(mode='OBJECT')
bpy.context.view_layer.update()
rest_error = max((o.matrix_world.translation / unit_scale - bind[i].translation).length * unit_scale
                 for i, o in joint_objects.items())
assert rest_error < 0.001, f'Output chain failed rest alignment: {rest_error}'
for i in bind:
    angle = (joint_objects[i].matrix_world.to_quaternion().inverted() @ bind[i].to_quaternion()).angle
    assert min(angle, math.tau - angle) < 0.001, f'Output rest rotation differs at joint {i}'

schedule, consolidation = deduplicate_actions(schedule, [track], scene)
pose_tools = prepare_pose_controls(rig)
if native_weltall:
    from weltall_mechanics import setup_mechanics
    from weltall_widgets import setup_widgets
    mechanics = setup_mechanics(rig)
    widget_report = setup_widgets(rig)
rig['reference_clips'] = len(schedule)
hands = json.loads(rig['hands'])

ui_text = bpy.data.texts.new('RIG CONTROLS - Run Script')
ui_text.write((Path(__file__).parent / 'id_rig_controls.py').read_text().replace(
    "'Weltall-Id Rig'", repr(label + ' Rig')).replace("'Id Rig'", repr(label + ' Rig')))
coverage_text = bpy.data.texts.new('SOURCE ANIMATION COVERAGE')
coverage = json.loads((source_folder / 'animation-reference.json').read_text())
coverage['blenderExport'] = {'consolidation': consolidation, 'timeline': schedule}
coverage_text.write(json.dumps(coverage, indent=2))
readme = bpy.data.texts.new('READ ME')
readme.write('''WELTALL-ID CUSTOM RIG

Frame 1: original Id rest pose; reshape meshes in Edit Mode here.
120 labeled Weltall reference actions run consecutively from frame 31 at 30 fps.
Each action is also available independently in the Action Editor.
Textures are packed, use nearest sampling, and keep the original pixel artwork.
Coincident triangle vertices are joined; UV corners and authored normals are preserved.

The file opens in FK with reference playback enabled.
Select a hand/foot BOX and press G to move it; R rotates the hand/foot.
Diamonds move the elbows/knees. Body/wing/armor rings rotate with R.
Root moves the entire rig; body/hip controls position the torso and pelvis.
Each hand/foot BOX has its own smooth IK blend property: 0 = FK, 1 = IK.
Both FK and IK controls remain accessible. Limb lengths stay fixed while blending.
IK target/pole transforms start unanimated; blend toward the pose you set with them.
Reference actions never key the blend sliders or IK target/pole transforms.
FK arm/leg rings use R to rotate, rather than G to translate.
Foot/toe rings follow the final ankle pose and still rotate independently.
The Reference animations NLA track plays all 120 FK clips consecutively.
Use the normal Action/NLA editors for new animation.
Each hand BOX also has its hand-state property: 0 = open, 1 = closed.
For a sidebar panel: open RIG CONTROLS - Run Script in the
Text Editor and Run Script once. No add-on installation or automatic execution is needed.
Its Id Rig panel contains the four blend sliders, two hand selectors, and wing toggle.
Id-only wing/fin controls retain their native hierarchy and remain editable.
CTRL-holo_wings is the back BOX: holo_wings is 0 = off, 1 = on.
The six original energy wing meshes and pixel texture are extracted from Field190.
They follow the six native wing joints, including their FK rotations.

Keep original mesh names, parents, origins, and material assignments.
Do not apply rig constraints, join objects, or change the original object transforms.
Save a separate edited .blend, then use:
node cli.mjs validate edited.blend --original exports/weltall-family/weltall-id
node cli.mjs import edited.blend --original exports/weltall-family/weltall-id --out <new-folder>
The importer bakes evaluated motion onto the original joints, then strips the controls.
Mesh/UV/texture edits, baked motion, hand swaps, and the wing visibility are imported.
Native Id animation data and source BIN files remain in the original package.

Retarget transfers bind-relative world rotations and scaled root motion. Id joint
spacing is retained. Different proportions mean contacts may need artistic cleanup.
The reference includes the same neutral battle context and partial Scene01_21 gap
as the Weltall source; effects/cameras and missing source motion are not recreated.
''')
instructions = readme.as_string().replace('120 labeled Weltall reference actions', f'{len(schedule)} unique Weltall reference actions')
instructions = instructions.replace('all 120 FK clips', f'all {len(schedule)} unique FK clips')
if native_weltall:
    instructions = f'''WELTALL CUSTOM RIG

Frame 1: original model rest pose; reshape meshes in Edit Mode here.
The audited 120 scene/battle clips are combined as {len(schedule)} unique actions,
back-to-back from frame 31 at 30 fps. Aliases are in SOURCE ANIMATION COVERAGE.
Textures are packed with nearest sampling. Coincident vertices are joined while
preserving UV corners, materials, and authored normals.

The file opens in FK. Reference actions key FK controls and original mesh visibility.
IK targets/poles remain unanimated, with all four blend sliders at zero.
Each wrist/foot box owns ik_blend: 0 = FK, 1 = IK. Move boxes with G, rotate with R.
Elbow/knee diamonds position the poles. FK rings rotate the individual parts.
Pose IK before blending; no automatic FK/IK matching or snap tools are provided.
Root places the rig; body shifts weight; pelvis offsets legs/skirt independently.
CTRL-chest_pose turns shoulders and torso shell together. Legacy CTRL-hips is the
torso base; legacy CTRL-chest is the shoulder girdle. Their source curves stay intact.
Foot and toe controls follow the final ankle while retaining their own rotations.
Each wrist has hand: 0 = open, 1 = closed, 2 = both, 3 = hidden.
Rest/reset is 2, preserving the original initialization/visibility scripts.

SIDEBAR
Open Scripting, select RIG CONTROLS - Run Script in the Text Editor's text dropdown,
hover over the editor and press Alt+P (Run Script). Return to Layout, select the
rig, enter Pose Mode, press N in the viewport, and open the Weltall Rig tab.
Run the script once each time you reopen Blender. No add-on or automatic script
execution is required. Read WELTALL ANIMATION GUIDE or the build's guide.html for
contacts, follow changes, keying, working actions, neutral poses, and seven demos.

Keep original mesh names, parenting, origins, transforms, and material assignments.
Edit mesh vertices/UVs; do not join original objects or apply rig constraints.
Save a separate edited .blend and keep the build's original/weltall folder.
From the release directory use:
weltall-rig.cmd import <edited.blend> --blender <blender-executable> --original <build-folder>/original/weltall --out <new-folder>
Source users replace weltall-rig.cmd with node cli.mjs. Import bakes evaluated
FK/IK motion onto the original nodes and produces a local GLB/model package;
it does not patch a game disc or write the original game BIN format.

This includes the audited Weltall library only. Scene08 motion is mapped onto the
canonical battle skeleton. Scene01_21 is labeled PARTIAL because source keyframe 44
is absent. Battle motion uses a fixed neutral capture context; cameras, sound,
and particle effects are not model animation. Weltall-2, Xenogears, and Id are not
included. Original source BINs remain untouched.
'''
readme.clear()
readme.write(instructions)
pose_instructions(scene)
if native_weltall:
    from weltall_workflow import setup_workflow
    workflow_report = setup_workflow(rig)
    from weltall_demos import create_demos
    demo_actions = create_demos(rig)
for material in bpy.data.materials:
    if material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE':
                node.interpolation = 'Closest'
bpy.ops.file.pack_all()
assert all(im.packed_file for im in bpy.data.images if im.type == 'IMAGE' and im.size[0])
meshes = [o for o in editable if o.type == 'MESH']
corners = [o.matrix_world @ Vector(v) for o in meshes for v in o.bound_box]
low = Vector([min(v[i] for v in corners) for i in range(3)])
high = Vector([max(v[i] for v in corners) for i in range(3)])
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            space = area.spaces.active
            space.shading.type = 'MATERIAL'
            space.overlay.show_extras = True
            space.region_3d.view_location = (low + high) / 2
            space.region_3d.view_distance = max(high - low) * 1.6
            space.region_3d.view_rotation = Euler((math.radians(80), 0, math.radians(145))).to_quaternion()
            space.clip_end = 10000
scene.unit_settings.system = 'METRIC'
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='POSE')
data.bones.active = data.bones['CTRL-root']
rig.pose.bones['CTRL-root'].select = True
report = {'model': model_id, 'source': 'weltall', 'fps': 30, 'clips': len(schedule),
          'rootMotionScale': root_ratio, 'jointSpacingErrorMeters': maximum_joint_error,
          'mapping': mapping, 'timeline': schedule, 'weldedMeshes': weld_report,
          'consolidation': consolidation, 'poseTools': pose_tools,
          'hands': hands, 'reviewedHandStates': AMBIGUOUS_STATES,
          'holoWings': json.loads(rig.get('holo_wings', '{}')),
          'idOriginalGlbSha256': id_manifest['originalGlbSha256'],
          'weltallReferenceSha256': source_manifest['reference']['sha256'],
          'sourceGaps': source_manifest['reference'].get('sourceGaps', []),
          'note': 'Reference retarget; fixed Id joint lengths. Contacts may need artistic cleanup.'}
if native_weltall:
    report['modelOriginalGlbSha256'] = report.pop('idOriginalGlbSha256')
    report.pop('reviewedHandStates')
    report['note'] = 'Native Weltall transforms and visibility preserved; Scene08 uses the audited source mapping.'
    report['mechanics'] = mechanics
    report['widgets'] = widget_report
    report['workflow'] = workflow_report
    report['demonstrations'] = demo_actions
destination.mkdir(parents=True)
(destination / ('rig-report.json' if native_weltall else 'retarget-report.json')).write_text(json.dumps(report, indent=2) + '\n')
bpy.ops.wm.save_as_mainfile(filepath=str(destination / (model_id + '-rigged.blend')))
print(f'CREATED {destination / (model_id + "-rigged.blend")}: {len(schedule)} reference clips', flush=True)
