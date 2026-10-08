"""Short editable contact studies, kept separate from the source reference actions."""
import json
import math

import bpy
from mathutils import Euler, Matrix


CONTACT_GUIDE = '''

CONTACT STUDIES
The seven DEMO/ actions are editable contact studies, separate from the 91 source
reference actions. Mute Reference animations and choose a DEMO action in the
Action Editor to play frames 1-61. Copy an action before editing it.
Before switching between demos or returning to references, leave NLA Tweak Mode,
turn Auto Key off, mute Reference animations, and clear the active Action using X.
In Pose Mode select Whole Body, then fully apply each Current File neutral asset:
Body, Arm L, Arm R, Leg L, and Leg R (Apply Pose, not a partial blend).
Select CTRL-root and use Alt+G then Alt+R to clear global placement too.
This resets transforms AND hand/blend/follow properties; Clear Transforms alone
does not reset properties. Now choose another DEMO action, or leave the Action
empty and unmute Reference animations. Scrub to the intended frame.
'''


def create_demos(rig):
    scene, data = bpy.context.scene, rig.animation_data
    neutral = {p.name: p.matrix_basis.copy() for p in rig.pose.bones}
    properties = {p.name: {key: p[key] for key in p.keys() if isinstance(p[key], (int, float))}
                  for p in rig.pose.bones}
    limbs = json.loads(rig['limbs'])
    data.use_nla = False
    runtime = {}
    exec(bpy.data.texts['RIG CONTROLS - Run Script'].as_string(), runtime)
    bpy.context.view_layer.objects.active = rig
    if rig.mode != 'POSE':
        bpy.ops.object.mode_set(mode='POSE')

    def reset():
        data.action = None
        for p in rig.pose.bones:
            p.matrix_basis = neutral[p.name]
            for key, value in properties[p.name].items():
                p[key] = value

    def rotate(name, xyz):
        p = rig.pose.bones['CTRL-' + name]
        if p.rotation_mode == 'QUATERNION':
            p.rotation_quaternion = Euler(xyz).to_quaternion()
        else:
            p.rotation_euler = xyz

    names = ('Walk contacts', 'Weight transfer', 'Crouch', 'Landing', 'Punch', 'Bracing', 'Follow and blend')
    result = []
    for title in names:
        reset()
        action = bpy.data.actions.new('DEMO/' + title)
        action.use_fake_user = True
        action['weltall_demo'] = True
        slot = action.slots.new(id_type='OBJECT', name=rig.name)
        action.use_frame_range = True
        action.frame_start, action.frame_end = 1, 61
        for frame in range(1, 62, 5):
            reset()
            scene.frame_set(frame)
            # Create keys from explicit poses, independent of earlier action keys.
            t = (frame - 1) / 60
            wave = math.sin(math.pi * t)
            cycle = math.sin(math.tau * t)
            body = rig.pose.bones['CTRL-body']
            body.location.z = -.55
            for limb in limbs:
                p = rig.pose.bones[limb['target']]
                p['ik_blend'] = 1.0 if limb['name'].startswith('leg') else 0.0
                if 'hand' in p:
                    p['hand'] = 0
            if title == 'Walk contacts':
                body.location.x = .24 * cycle
                body.location.y = -1.6 * t
                for side, sign in (('L', 1), ('R', -1)):
                    step = max(0., min(1., 2 * t - (0 if side == 'L' else 1)))
                    swing = math.sin(math.pi * step)
                    foot = rig.pose.bones['CTRL-foot_ik.' + side]
                    foot.location.y = -1.6 * step * step * (3 - 2 * step)
                    foot.location.z = .6 * swing
                    rotate('upper_arm.' + side, (.25 * cycle * sign, 0, 0))
            elif title == 'Weight transfer':
                body.location.x = .6 * cycle
                rotate('pelvis', (0, .06 * cycle, 0))
                rotate('chest_pose', (0, -.06 * cycle, 0))
            elif title == 'Crouch':
                body.location.z = -.55 - 1.8 * wave
                body.location.y = .25 * wave
                rotate('chest_pose', (.12 * wave, 0, 0))
                for side in ('L', 'R'):
                    rotate('skirt.' + side, (-.15 * wave, 0, 0))
            elif title == 'Landing':
                compression = math.sin(math.pi * min(1., t * 1.5))
                body.location.z = -.25 - 1.55 * compression
                rotate('chest_pose', (.13 * compression, 0, 0))
                for side in ('L', 'R'):
                    rotate('toe_contact.' + side, (.08 * (1 - compression), 0, 0))
                    rotate('upper_arm.' + side, (-.3 * compression, 0, 0))
            elif title == 'Punch':
                hand = rig.pose.bones['CTRL-hand_ik.R']
                hand['ik_blend'], hand['hand'] = 1., 1
                hand.location = (0, -.8 - 2.1 * wave, 1.5 + 1.3 * wave)
                rotate('hand_ik.R', (1.1 * wave, 0, 0))
                rotate('chest_pose', (0, 0, .12 * wave))
                body.location.y = -.25 * wave
            elif title == 'Bracing':
                for side in ('L', 'R'):
                    hand = rig.pose.bones['CTRL-hand_ik.' + side]
                    hand['ik_blend'], hand['follow'] = 1., 2
                    hand.location = (0, -2.5, 2.8)
                    rotate('hand_ik.' + side, (1.1, 0, 0))
                body.location.y = -.4 * wave
                rotate('chest_pose', (.12 * wave, 0, 0))
            else:
                hand = rig.pose.bones['CTRL-hand_ik.L']
                hand['ik_blend'] = t
                hand.location = (0, -1.7, 1.7)
                rotate('upper_arm.L', (.3, 0, 0))
                rotate('forearm.L', (.3, 0, 0))
                rotate('hand_contact.L', (.15 * wave, 0, 0))
                hand['hand'] = 1 if t > .5 else 0
                # Root and World coincide at frame31. Afterwards the global root
                # moves while the world-space left hand goal remains planted.
                hand['follow'] = 0 if frame < 31 else 2
                rig.pose.bones['CTRL-root'].location.x = max(0., t - .5) * .6
            rig.update_tag()
            bpy.context.view_layer.update()
            data.action, data.action_slot = action, slot
            for p, channel, index in runtime['keyed_channels'](rig, 'Whole Body'):
                if index < 0:
                    p.keyframe_insert(channel, frame=frame, group=p.name)
                else:
                    p.keyframe_insert(channel, index=index, frame=frame, group=p.name)
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        discrete = curve.data_path.endswith(('["follow"]', '["hand"]'))
                        for key in curve.keyframe_points:
                            key.interpolation = 'CONSTANT' if discrete else 'BEZIER'
                            if not discrete:
                                key.handle_left_type = key.handle_right_type = 'AUTO_CLAMPED'
        result.append(action.name)
    reset()
    data.use_nla = True
    scene.frame_set(1)
    rig.update_tag()
    bpy.context.view_layer.update()
    rig['demo_actions'] = json.dumps(result)
    bpy.data.texts['WELTALL ANIMATION GUIDE'].write(CONTACT_GUIDE)
    bpy.ops.object.mode_set(mode='OBJECT')
    return result
