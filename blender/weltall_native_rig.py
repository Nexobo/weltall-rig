"""Preserve Weltall's extracted mesh visibility and four native hand states."""
import json

from mathutils import Matrix


HAND_JOINTS = {'L': (22, 23), 'R': (28, 29)}  # Closed, open.
HAND_INDICES = {index for pair in HAND_JOINTS.values() for index in pair}


def _carriers(original):
    return {int(obj['sourceNodeIndex']): obj for obj in original
            if obj.get('transformRole') == 'mesh-visibility-carrier'}


def _visible(scale):
    values = tuple(float(value) for value in scale)
    assert values in ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), values
    return values[0] == 1.0


def _state(closed, opened):
    return {(False, True): 0, (True, False): 1,
            (True, True): 2, (False, False): 3}[closed, opened]


def initialize_native_visibility(rig, original, bone):
    """Create independent, hidden scale channels while the armature is in Edit Mode."""
    for index in _carriers(original):
        if index not in HAND_INDICES:
            bone(f'MCH-display-{index:03}', Matrix.Identity(4))


def setup_native_visibility(rig, original):
    """Use the extracted open/closed meshes; do not synthesize replacement hands."""
    carriers = _carriers(original)
    for index, obj in carriers.items():
        if index in HAND_INDICES:
            continue
        name = f'MCH-display-{index:03}'
        rig.pose.bones[name].scale = obj.scale
        rig.data.collections['Mechanism'].assign(rig.data.bones[name])
        rig.data.bones[name].hide_select = True
        constraint = obj.constraints.new('COPY_SCALE')
        constraint.name = 'Gear rig output visibility'
        constraint.target, constraint.subtarget = rig, name
        constraint.owner_space = constraint.target_space = 'LOCAL'

    hands = []
    for side, (closed_index, open_index) in HAND_JOINTS.items():
        closed, opened = carriers[closed_index], carriers[open_index]
        control = rig.pose.bones[f'CTRL-hand_ik.{side}']
        property_name = f'hand_{side}'
        control[property_name] = _state(_visible(closed.scale), _visible(opened.scale))
        control.id_properties_ui(property_name).update(
            min=0, max=3,
            description='Hand shape: 0 = open, 1 = closed, 2 = both, 3 = hidden')
        for obj, state in ((opened, 0), (closed, 1)):
            for axis in range(3):
                driver = obj.driver_add('scale', axis).driver
                variable = driver.variables.new()
                variable.name, variable.type = 'hand', 'SINGLE_PROP'
                variable.targets[0].id = rig
                variable.targets[0].data_path = control.path_from_id() + f'["{property_name}"]'
                driver.expression = f'hand == {state} or hand == 2'
        hands.append({'side': side, 'control': control.name, 'property': property_name,
                      'original': opened.name, 'closed': closed.name, 'native': True})
    rig['hands'] = json.dumps(hands)
    return hands


def capture_visibility(trs, hand_nodes):
    """Read every source hand state, including initialization and hidden intervals."""
    return {side: _state(_visible(trs[closed][2]), _visible(trs[opened][2]))
            for side, (closed, opened) in hand_nodes.items()}


def key_native_visibility(bag, curve, frames, trs_frames, source_nodes, hands, rig):
    """Put all native display channels in the same rig action as its motion."""
    displays = {int(node['extras']['sourceNodeIndex']): index
                for index, node in enumerate(source_nodes)
                if node.get('extras', {}).get('transformRole') == 'mesh-visibility-carrier'}
    hand_nodes = {side: tuple(displays[index] for index in joints)
                  for side, joints in HAND_JOINTS.items()}
    hand_states = [capture_visibility(trs, hand_nodes) for trs in trs_frames]
    for index, node in displays.items():
        if index in HAND_INDICES:
            continue
        control = rig.pose.bones[f'MCH-display-{index:03}']
        curve(bag, control.path_from_id('scale'), [trs[node][2] for trs in trs_frames],
              frames, 'Visibility', True)
    for hand in hands:
        control = rig.pose.bones[hand['control']]
        curve(bag, control.path_from_id() + f'["{hand["property"]}"]',
              [states[hand['side']] for states in hand_states], frames, 'Hands', True)
