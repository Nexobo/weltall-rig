"""Original Field190 wing meshes, attached to Id's native wing bones."""
import hashlib
import json
from pathlib import Path

import bpy


def initialize_holo_wings(rig, joint_objects):
    assets = Path(__file__).parent.parent / 'assets'
    source = json.loads((assets / 'id-holo-wings.json').read_text())
    assert hashlib.sha256((assets / source['texture']['file']).read_bytes()).hexdigest() == source['texture']['sha256']
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(assets / 'id-holo-wings.glb'))
    objects = sorted(set(bpy.data.objects) - before, key=lambda obj: obj.name)
    assert len(objects) == 6 and all(obj.type == 'MESH' for obj in objects)
    control = rig.pose.bones['CTRL-holo_wings']
    control['holo_wings'] = 1
    control.id_properties_ui('holo_wings').update(min=0, max=1, description='Original energy wings: 0 = off, 1 = on')
    rest = {}
    for obj in objects:
        joint = int(obj['sourceNodeIndex'])
        assert obj.name == f'Id_Holo_Wing_{joint:03}' and joint in range(49, 55)
        obj.parent = joint_objects[joint]
        rest[obj.name] = [list(row) for row in obj.matrix_basis]
        for axis in range(3):
            driver = obj.driver_add('scale', axis).driver
            variable = driver.variables.new()
            variable.name, variable.type = 'visible', 'SINGLE_PROP'
            variable.targets[0].id = rig
            variable.targets[0].data_path = control.path_from_id() + '["holo_wings"]'
            driver.expression = 'visible'
    rig['holo_wings'] = json.dumps({'control': control.name, 'property': 'holo_wings',
                                   'objects': [obj.name for obj in objects], 'restTransforms': rest,
                                   'source': source['source']})
    bpy.context.view_layer.objects.active = rig
    return objects
