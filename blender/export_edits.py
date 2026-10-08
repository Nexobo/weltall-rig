"""Export edited assets and bake Id control actions onto the original model nodes."""
import bpy
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from mathutils import Matrix

source, destination = [Path(s).resolve() for s in sys.argv[sys.argv.index('--') + 1:]]
bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False)
scene = bpy.context.scene
assert scene.get('editing_frame') == 1, 'Not a prepared Gear Blender scene'
# Export the model scene only, including when a reference scene is linked in.
for other_scene in list(bpy.data.scenes):
    if other_scene != scene:
        bpy.data.scenes.remove(other_scene)
rig_name = scene.get('control_rig', 'Weltall-Id RIG')
if bpy.data.objects.get(rig_name):
    sys.path.insert(0, str(Path(__file__).parent))
    from rig_pose_tools import exit_action_editing
    exit_action_editing(bpy.data.objects[rig_name])


def bake_id_actions(objects):
    rig = bpy.data.objects[rig_name]
    data = rig.animation_data
    if rig.get('animation_neutral'):
        neutral = json.loads(rig['animation_neutral'])
        paths = {}
        for p in rig.pose.bones:
            for channel in ('location', 'rotation_quaternion', 'rotation_euler', 'scale'):
                paths[p.path_from_id(channel)] = (p, channel, False)
            for key in neutral[p.name]['properties']:
                paths[p.path_from_id() + '["' + bpy.utils.escape_identifier(key) + '"]'] = (p, key, True)
        animated = set()
        for action in bpy.data.actions:
            if action.get('weltall_pose_asset') or not any(s.name_display == rig.name for s in action.slots):
                continue
            for layer in action.layers:
                for strip in layer.strips:
                    for bag in strip.channelbags:
                        animated.update((curve.data_path, curve.array_index) for curve in bag.fcurves)
        data.action = None
        data.use_nla = False
        for path, index in animated:
            if path not in paths:
                continue
            p, channel, custom = paths[path]
            if custom:
                p[channel] = neutral[p.name]['properties'][channel]
            else:
                getattr(p, channel)[index] = neutral[p.name][channel][index]
    # Each action is independent. Unkeyed IK controls retain their saved pose, and
    # animated switches cannot leak their final value into the next action.
    base = {p.name: (p.matrix_basis.copy(), {k: p[k] for k in p.keys()
            if isinstance(p[k], (int, float))}) for p in rig.pose.bones}
    rig_basis = rig.matrix_basis.copy()
    rig_hidden = rig.hide_render
    axis = Matrix.Rotation(math.pi / 2, 4, 'X')
    inverse_axis = axis.inverted()
    fps = scene.render.fps / scene.render.fps_base

    def reset():
        data.action = None
        rig.matrix_basis = rig_basis
        rig.hide_render = rig_hidden
        for p in rig.pose.bones:
            matrix, properties = base[p.name]
            p.matrix_basis = matrix
            for key, value in properties.items():
                p[key] = value
        rig.update_tag()

    def sample_clip(name, start, end):
        frames = range(math.floor(start), max(math.floor(start) + 1, math.ceil(end)) + 1)
        values = {o.name: {'translation': [], 'rotation': [], 'scale': []} for o in objects}
        previous = {}
        for frame in frames:
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            depsgraph = bpy.context.evaluated_depsgraph_get()
            for obj in objects:
                evaluated = obj.evaluated_get(depsgraph)
                local = (evaluated.parent.matrix_world.inverted() @ evaluated.matrix_world
                         if evaluated.parent else evaluated.matrix_world)
                location, rotation, scale = (inverse_axis @ local @ axis).decompose()
                if obj.type == 'MESH' and obj.hide_render:
                    scale[:] = (0, 0, 0)
                if obj.name in previous and rotation.dot(previous[obj.name]) < 0:
                    rotation.negate()
                previous[obj.name] = rotation.copy()
                values[obj.name]['translation'].append(tuple(location))
                values[obj.name]['rotation'].append((rotation.x, rotation.y, rotation.z, rotation.w))
                values[obj.name]['scale'].append(tuple(scale))
        return {'name': name, 'times': np.arange(len(frames), dtype='<f4') / fps,
                'values': values}

    actions = []
    for action in bpy.data.actions:
        if action.library != rig.library:
            continue
        if action.name.startswith('REST POSE') or action.get('weltall_pose_asset'):
            continue
        slots = [s for s in action.slots if s.target_id_type == 'OBJECT' and s.name_display == rig.name]
        if slots:
            actions.append((action, slots[0]))
    clips = []
    data.use_nla = False
    for index, (action, slot) in enumerate(actions):
        reset()
        data.action = action
        data.action_slot = slot
        clips.append(sample_clip(action.name, *action.frame_range))
        if index % 20 == 0:
            print(f'BAKE {index + 1}/{len(actions)}', flush=True)
    # Preserve deliberate NLA edits as an evaluated timeline, without duplicating
    # the unchanged consecutive reference track.
    if any(not t.mute and not t.name.startswith('Reference animations') for t in data.nla_tracks):
        reset()
        data.use_nla = True
        clips.append(sample_clip('Edited timeline', scene.frame_start, scene.frame_end))
    reset()
    data.use_nla = False
    bpy.context.view_layer.update()
    return clips


def append_animations(path, clips, hands, holo_wings):
    raw = path.read_bytes()
    size, kind = struct.unpack_from('<II', raw, 12)
    assert kind == 0x4E4F534A
    document = json.loads(raw[20:20 + size])
    binary_size, kind = struct.unpack_from('<II', raw, 20 + size)
    assert kind == 0x004E4942
    binary = bytearray(raw[28 + size:28 + size + binary_size])
    names = {n['name']: i for i, n in enumerate(document['nodes'])}
    visibility = {h[key] for h in hands for key in ('original', 'closed')}
    visibility.update(holo_wings.get('objects', []))
    visibility.update(n['name'] for n in document['nodes']
                      if n.get('extras', {}).get('transformRole') == 'mesh-visibility-carrier')

    def accessor(values, width):
        array = np.asarray(values, dtype='<f4').reshape(-1, width)
        view = len(document.setdefault('bufferViews', []))
        document['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': array.nbytes})
        binary.extend(array.tobytes())
        index = len(document.setdefault('accessors', []))
        document['accessors'].append({'bufferView': view, 'componentType': 5126,
            'count': len(array), 'type': {1: 'SCALAR', 3: 'VEC3', 4: 'VEC4'}[width],
            'min': array.min(axis=0).tolist(), 'max': array.max(axis=0).tolist()})
        return index

    animations = []
    for clip in clips:
        animation = {'name': clip['name'], 'samplers': [], 'channels': []}
        input_index = None
        for name, channels in clip['values'].items():
            node = document['nodes'][names[name]]
            for channel, values in channels.items():
                rest = node.get(channel, {'translation': [0, 0, 0],
                    'rotation': [0, 0, 0, 1], 'scale': [1, 1, 1]}[channel])
                array = np.asarray(values, dtype='<f4')
                if channel == 'rotation' and np.dot(array[0], rest) < 0:
                    array = -array
                if not (name in visibility and channel == 'scale') and np.allclose(array, rest, atol=1e-6, rtol=1e-6):
                    continue
                if input_index is None:
                    input_index = accessor(clip['times'], 1)
                sampler = len(animation['samplers'])
                animation['samplers'].append({'input': input_index,
                    'output': accessor(array, 4 if channel == 'rotation' else 3),
                    'interpolation': 'STEP' if name in visibility and channel == 'scale' else 'LINEAR'})
                animation['channels'].append({'sampler': sampler,
                    'target': {'node': names[name], 'path': channel}})
        # A motionless action still has a valid timeline and remains selectable.
        if not animation['channels']:
            node = names[next(iter(clip['values']))]
            animation['samplers'].append({'input': accessor(clip['times'], 1),
                'output': accessor(clip['values'][document['nodes'][node]['name']]['translation'], 3),
                'interpolation': 'LINEAR'})
            animation['channels'].append({'sampler': 0, 'target': {'node': node, 'path': 'translation'}})
        animations.append(animation)
    document['animations'] = animations
    for hand in hands:
        if not hand.get('native'):
            document['nodes'][names[hand['closed']]]['scale'] = [0, 0, 0]
    document['buffers'][0]['byteLength'] = len(binary)
    text = json.dumps(document, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    binary += b'\0' * (-len(binary) % 4)
    path.write_bytes(struct.pack('<III', 0x46546C67, 2, 28 + len(text) + len(binary)) +
        struct.pack('<II', len(text), 0x4E4F534A) + text +
        struct.pack('<II', len(binary), 0x004E4942) + binary)


clips, hands, holo_wings = [], [], {}
scene.frame_set(1)
bpy.context.view_layer.update()
if scene.get('custom_id_rig') or scene.get('custom_gear_rig'):
    original = json.loads(bpy.data.texts['ORIGINAL MODEL TRANSFORMS'].as_string())
    rig = bpy.data.objects[rig_name]
    hands = json.loads(rig.get('hands', '[]'))
    holo_wings = json.loads(rig.get('holo_wings', '{}'))
    for hand in hands:
        if not hand.get('native'):
            original[hand['closed']] = original[hand['original']]
    original.update(holo_wings.get('restTransforms', {}))
    objects = []
    for name in original:
        obj = bpy.data.objects.get(name)
        assert obj is not None, f'Original object missing or renamed: {name}'
        objects.append(obj)
    clips = bake_id_actions(objects)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        for constraint in obj.constraints:
            if constraint.name.startswith(('Id rig output ', 'Gear rig output ')):
                constraint.mute = True
        drivers = list(obj.animation_data.drivers) if obj.animation_data else []
        for driver in drivers:
            driver.mute = True
        if any(d.data_path == 'scale' for d in drivers):
            obj.scale = Matrix(original[obj.name]).to_scale()
        obj.select_set(True)
    bpy.context.view_layer.update()
    bpy.ops.export_scene.gltf(filepath=str(destination), export_format='GLB',
        export_animations=False, export_current_frame=True, export_extras=True,
        use_selection=True, use_active_scene=True, export_skins=False)
    append_animations(destination, clips, hands, holo_wings)
else:
    # The validator catches object/pivot changes in ordinary mesh edits.
    bpy.ops.export_scene.gltf(filepath=str(destination), export_format='GLB',
        export_animations=False, export_current_frame=True, export_extras=True,
        use_active_scene=True)
