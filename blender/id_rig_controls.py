"""Optional sidebar for limb blends, hand states, and original energy wings."""
import bpy
import json


class IDRIG_PT_controls(bpy.types.Panel):
    bl_label = 'Weltall-Id Rig'
    bl_idname = 'IDRIG_PT_controls'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Id Rig'

    @classmethod
    def poll(cls, context):
        return bool(context.scene.get('control_rig') or bpy.data.objects.get('Weltall-Id RIG'))

    def draw(self, context):
        rig = bpy.data.objects[context.scene.get('control_rig', 'Weltall-Id RIG')]
        self.layout.label(text='0 = FK / 1 = IK')
        for limb in json.loads(rig['limbs']):
            control = rig.pose.bones[limb['control']]
            self.layout.prop(control, f'["{limb["switch"]}"]', text=limb['name'], slider=True)
        for hand in json.loads(rig['hands']):
            control = rig.pose.bones[hand['control']]
            self.layout.prop(control, f'["{hand["property"]}"]', text=f'Hand {hand["side"]} (0 open / 1 closed)')
        if rig.get('holo_wings'):
            wings = json.loads(rig['holo_wings'])
            self.layout.prop(rig.pose.bones[wings['control']], f'["{wings["property"]}"]', text='Holo wings (0 off / 1 on)')


previous = getattr(bpy.types, IDRIG_PT_controls.__name__, None)
if previous:
    bpy.utils.unregister_class(previous)
bpy.utils.register_class(IDRIG_PT_controls)
