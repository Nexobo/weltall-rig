"""Id hand shapes and the reviewed Weltall hand-state transfer."""
import json

import bpy
from mathutils import Vector


# These short source scripts initialize or briefly hide the hand meshes. Id always
# keeps one hand per wrist. Decisions are explicit, rather than guessing a state.
AMBIGUOUS_STATES = {
    'Battle_02': {'R': 0},       # Open before and after the hidden interval.
    'Battle_05': {'L': 1, 'R': 0},  # Hold the last visible attack pose.
    'Battle_22': {'L': 1, 'R': 0},  # The source's neutral battle hand configuration.
    'Scene01_00': {'L': 0, 'R': 0},  # Initialization displays both source shapes.
    'Scene01_20': {'L': 0, 'R': 0},  # Resolves to two open hands on its last frame.
    'Scene08_00': {'L': 0, 'R': 0},  # Initialization displays both source shapes.
    'Scene08_10': {'L': 0, 'R': 0},
    'Scene08_11': {'L': 0, 'R': 0},
}


def source_hand_nodes(source):
    """Return the closed/open visibility carriers, distinct from wrist joints."""
    indices = {int(node['extras']['sourceNodeIndex']): i
               for i, node in enumerate(source['nodes'])
               if node.get('extras', {}).get('transformRole') == 'model-local-bone'}
    result = {}
    for side, joints in (('L', (22, 23)), ('R', (28, 29))):
        result[side] = tuple(next(child for child in source['nodes'][indices[joint]]['children']
                                 if 'mesh' in source['nodes'][child]) for joint in joints)
    return result


def source_hand_state(source_trs, hand_nodes, clip_name):
    """0=open, 1=closed. Only the eight reviewed clips may be ambiguous."""
    states = {}
    for side, (closed, opened) in hand_nodes.items():
        visible = tuple(any(abs(float(v)) > 0.01 for v in source_trs[node][2])
                        for node in (closed, opened))
        if visible == (True, False):
            states[side] = 1
        elif visible == (False, True):
            states[side] = 0
        else:
            assert clip_name in AMBIGUOUS_STATES and side in AMBIGUOUS_STATES[clip_name], (
                f'Unreviewed hand visibility in {clip_name}: {side} {visible}')
            states[side] = AMBIGUOUS_STATES[clip_name][side]
    return states


def _close_hand(mesh, side):
    # Keep the native wrist and palm. Fold the two distal claw corners inward,
    # tuck the thumb against the palm, and preserve the original UV corners.
    # The left-hand geometry is the mirrored right hand in these local axes.
    scale = max(vertex.co.z for vertex in mesh.vertices) / 958.0
    mirror = -1 if side == 'L' else 1
    moved = 0
    for vertex in mesh.vertices:
        # Blender's glTF importer rotates mesh coordinates from Y-up to Z-up.
        point = Vector((vertex.co.x, vertex.co.z, -vertex.co.y)) / scale
        point.x *= mirror
        if point.y > 850:
            point.x = -270 if point.z < 0 else -245
            point.y = 465 if point.z < 0 else 440
            point.z *= 0.9
        elif 600 < point.y < 650:
            point.x, point.y, point.z = -245, 385, -110
        else:
            continue
        point.x *= mirror
        vertex.co = Vector((point.x, -point.z, point.y)) * scale
        moved += 1
    assert moved == 3, f'Unexpected Id hand geometry: {side}, {moved} claw corners'
    mesh.update()
    # The open-hand split normals no longer describe the folded claw surfaces.
    mesh.normals_split_custom_set([(0, 0, 0)] * len(mesh.loops))


def initialize_hand_swaps(rig, joint_objects, original):
    """Add two closed mesh leaves and complementary stepped scale drivers."""
    hands = []
    for side, joint in (('L', 18), ('R', 10)):
        control = f'CTRL-hand_ik.{side}'
        settings = rig.pose.bones[control]
        opened = next(obj for obj in original
                      if obj.type == 'MESH' and obj.parent == joint_objects[joint])
        closed = opened.copy()
        closed.data = opened.data.copy()
        closed.name = f'Id_Hand_Closed.{side}'
        closed.data.name = f'Id closed hand {side}'
        _close_hand(closed.data, side)
        opened.users_collection[0].objects.link(closed)
        closed['custom_id_hand_variant'] = 1
        closed['handSide'] = side
        closed['handState'] = 'closed'
        closed['originalDisplayName'] = opened.name
        closed['sourceNodeIndex'] = joint
        closed['transformRole'] = 'mesh-visibility-carrier'
        property_name = f'hand_{side}'
        settings[property_name] = 0
        settings.id_properties_ui(property_name).update(
            min=0, max=1, description='Hand shape: 0 = open, 1 = closed')
        for obj, expression in ((opened, '1 - hand'), (closed, 'hand')):
            assert tuple(obj.scale) == (1, 1, 1), f'Unexpected hand carrier scale: {obj.name}'
            for axis in range(3):
                driver = obj.driver_add('scale', axis).driver
                variable = driver.variables.new()
                variable.name, variable.type = 'hand', 'SINGLE_PROP'
                variable.targets[0].id = rig
                variable.targets[0].data_path = settings.path_from_id() + f'["{property_name}"]'
                driver.expression = expression
        hands.append({'side': side, 'property': property_name, 'control': control, 'joint': joint,
                      'original': opened.name, 'closed': closed.name})
    rig['hands'] = json.dumps(hands)
    return hands
