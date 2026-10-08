"""Weltall's fitted animator widgets and edit permissions; no evaluation changes."""
import json
import math

import bpy
from mathutils import Matrix, Vector


class Wire:
    def __init__(self):
        self.vertices, self.edges = [], []

    def line(self, points, closed=False):
        start = len(self.vertices)
        self.vertices.extend(Vector(p) for p in points)
        self.edges.extend((start + i, start + i + 1) for i in range(len(points) - 1))
        if closed:
            self.edges.append((start + len(points) - 1, start))
        return self

    def ellipse(self, center, radii, plane='XY', start=0, end=math.tau, segments=32):
        axes = {'XY': (0, 1), 'XZ': (0, 2), 'YZ': (1, 2)}[plane]
        points = []
        closed = abs(end - start - math.tau) < 1e-6
        for i in range(segments if closed else segments + 1):
            a = start + (end - start) * i / segments
            p = Vector(center)
            p[axes[0]] += math.cos(a) * radii[0]
            p[axes[1]] += math.sin(a) * radii[1]
            points.append(p)
        return self.line(points, closed)

    def box(self, low, high):
        points = [Vector((x, y, z)) for x in (low[0], high[0])
                  for y in (low[1], high[1]) for z in (low[2], high[2])]
        offset = len(self.vertices)
        self.vertices.extend(points)
        self.edges.extend((offset + a, offset + b) for a in range(8) for b in range(a + 1, 8)
                          if sum(points[a][i] != points[b][i] for i in range(3)) == 1)
        return self


def rest_mesh_bounds(rig):
    """Use stored import transforms, independent of the current timeline frame."""
    original = json.loads(bpy.data.texts['ORIGINAL MODEL TRANSFORMS'].as_string())
    world = {}

    def matrix(obj):
        if obj.name not in world:
            parent = matrix(obj.parent) if obj.parent and obj.parent.name in original else Matrix.Identity(4)
            world[obj.name] = parent @ Matrix(original[obj.name])
        return world[obj.name]

    inverse = rig.matrix_world.inverted()
    bounds = {}
    for name in original:
        obj = bpy.data.objects[name]
        if obj.type != 'MESH':
            continue
        transform = inverse @ matrix(obj)
        points = [transform @ v.co for v in obj.data.vertices]
        bounds[name] = (Vector([min(p[i] for p in points) for i in range(3)]),
                        Vector([max(p[i] for p in points) for i in range(3)]))
    return bounds


def control_collection(name):
    if any(t in name for t in ('_ik.', 'elbow.', 'knee.')):
        return 'IK'
    if 'contact' in name or 'pivot' in name:
        return 'Contacts'
    if 'wing_' in name:
        return 'Wings'
    if any(t in name for t in ('armor', 'fin', 'skirt', 'foot_inner', 'foot_outer')):
        return 'Armor'
    if any(t in name for t in ('arm.', 'hand_fk', 'clavicle')):
        return 'FK arms'
    if any(t in name for t in ('thigh.', 'shin.', 'ankle', 'foot.', 'toe.')):
        return 'FK legs'
    return 'Body'


def _widget(rig, name, bounds, joint_map):
    """Draw in armature rest space; only the widget mesh is later rebased."""
    p = rig.data.bones[name].head_local.copy()
    side = -1 if name.endswith('.L') else 1
    w = Wire()
    if name == 'CTRL-root':
        # Broken circular compass with four broad directional tabs; front is -Y.
        for a in range(4):
            angle = a * math.pi / 2
            w.ellipse((0, 0, .06), (3.75, 4.15), start=angle + .15,
                      end=angle + math.pi / 2 - .15, segments=12)
        for axis, sign in ((0, -1), (0, 1), (1, -1), (1, 1)):
            tangent = 1 - axis
            c = Vector((0, 0, .06)); c[axis] = sign * (3.75 if axis == 0 else 4.15)
            a = c.copy(); a[tangent] -= .35
            b = c.copy(); b[axis] += sign * .55
            d = c.copy(); d[tangent] += .35
            w.line((a, b, d, a))
        return w
    if name in ('CTRL-body', 'CTRL-hips', 'CTRL-pelvis', 'CTRL-chest', 'CTRL-chest_pose'):
        rx, ry, z = {'CTRL-body': (2.6, 1.8, -.1), 'CTRL-hips': (1.55, 1.18, .15),
                     'CTRL-pelvis': (1.85, 1.38, -.65), 'CTRL-chest': (1.7, 1.35, .45),
                     'CTRL-chest_pose': (2.15, 1.62, -.8)}[name]
        if name == 'CTRL-body':
            points = [(rx * math.cos(a), ry * math.sin(a), z)
                      for a in [math.tau * i / 8 for i in range(8)]]
        else:
            points = [(-rx, -.6 * ry, z), (-.7 * rx, -ry, z), (.7 * rx, -ry, z),
                      (rx, -.6 * ry, z), (rx, .6 * ry, z), (.7 * rx, ry, z),
                      (-.7 * rx, ry, z), (-rx, .6 * ry, z)]
        w.line([p + Vector(v) for v in points], True)
        # A front crest provides a selectable edge in the straight front view.
        w.line([p + Vector(v) for v in ((-.45, -ry, z), (0, -ry, z + .34), (.45, -ry, z))])
        for x in (-rx, rx):
            w.ellipse(p + Vector((x, 0, z)), (.45, .22), 'YZ', 0, math.pi, 10)
        return w
    if name == 'CTRL-spine':
        w.line([p + Vector(v) for v in ((-.5, -1.55, -.15), (0, -1.55, .22),
                                       (.5, -1.55, -.15), (0, -1.55, -.5))], True)
        return w.line([p + Vector(v) for v in ((0, -1.55, -.5), (0, -1.83, -.15),
                                              (0, -1.55, .22))])
    if name == 'CTRL-head':
        low, high = bounds['Bone_031_Display']
        z = high.z + .28
        center = Vector((p.x, (low.y + high.y) / 2, z))
        w.ellipse(center, (1.17, 1.52))
        w.line([(p.x - .35, low.y - .25, z), (p.x, low.y - .6, z),
                (p.x + .35, low.y - .25, z)])
        # Short rear arch is visible in front and side views.
        w.ellipse(center, (1.17, .38), 'XZ', 0, math.pi, 12)
        w.ellipse(center, (1.52, .38), 'YZ', 0, math.pi, 12)
        return w
    if 'clavicle.' in name:
        c = p + Vector((side * .25, -.65, .15))
        w.ellipse(c, (1.05, .95), 'XZ', .05, math.pi - .05, 18)
        w.ellipse(c, (.75, .65), 'YZ', .05, math.pi - .05, 14)
        return w.line([c + Vector((-1.05, 0, 0)), c + Vector((-1.05, .3, -.15))])
    if any(t in name for t in ('elbow.', 'knee.')):
        # Offset the visible handle outboard: its projection must not coincide
        # with knee/forearm armor in the front view. The actual pole is untouched.
        c = p + Vector((side * 1.35, 0, 0))
        w.line([c + Vector(v) for v in ((-.3, 0, -.4), (.3, 0, -.4),
                    (.45, 0, 0), (.3, 0, .4), (-.3, 0, .4), (-.45, 0, 0))], True)
        w.line([c + Vector(v) for v in ((0, -.3, -.4), (0, .3, -.4),
                    (0, .45, 0), (0, .3, .4), (0, -.3, .4), (0, -.45, 0))], True)
        return w
    if 'hand_ik.' in name:
        # Outer palm cage sits below the smaller FK wrist cuff.
        c = p + Vector((side * .12, 0, -.55))
        w.box(c + Vector((-.66, -.68, -.63)), c + Vector((.66, .68, .38)))
        return w.line([c + Vector(v) for v in ((-.3, -.68, -.63), (0, -.92, -.63), (.3, -.68, -.63))])
    if 'foot_ik.' in name:
        indices = (6, 7, 38, 39) if side == -1 else (13, 14, 43, 44)
        lows, highs = zip(*(bounds[f'Bone_{i:03}_Display'] for i in indices))
        x0, x1 = min(v.x for v in lows) - .16, max(v.x for v in highs) + .16
        y0, y1 = min(v.y for v in lows) - .2, max(v.y for v in highs) + .18
        z = min(v.z for v in lows) - .015
        w.line([(x0 + .2, y0, z), (x1 - .2, y0, z), (x1, y0 + .25, z),
                (x1, y1 - .2, z), (x1 - .3, y1, z), (x0 + .3, y1, z),
                (x0, y1 - .2, z), (x0, y0 + .25, z)], True)
        # Heel riser remains visible in profile and separates the outline from FK.
        w.line([(x0, y1 - .2, z), (x0, y1 - .2, z + .4),
                (x1, y1 - .2, z + .4), (x1, y1 - .2, z)])
        return w
    if 'bank_contact.' in name:
        # An outboard rocker visually advertises the single bank axis (local Y).
        c = p + Vector((side * 1.7, 0, .7))
        w.ellipse(c, (.62, .45), 'XZ', .15 * math.pi, .85 * math.pi, 18)
        w.line([c + Vector(v) for v in ((-.56, 0, .2), (-.7, 0, .14), (-.64, 0, .42))])
        w.line([c + Vector(v) for v in ((.56, 0, .2), (.7, 0, .14), (.64, 0, .42))])
        return w.line([c + Vector(v) for v in ((0, -.27, 0), (0, .27, 0))])
    if 'heel_contact.' in name:
        # Rear heel bracket, above the IK sole outline; raised to distinguish it
        # from the toe handle when looking directly at the front of the character.
        c = p + Vector((0, .28, .75))
        w.line([c + Vector(v) for v in ((-.65, -.25, 0), (-.65, .2, 0),
                      (-.45, .4, 0), (.45, .4, 0), (.65, .2, 0), (.65, -.25, 0))])
        w.line([c + Vector(v) for v in ((-.45, .4, 0), (0, .4, .3), (.45, .4, 0))])
        return w.ellipse(c + Vector((side * .65, 0, 0)), (.4, .3), 'YZ',
                         -.15 * math.pi, .85 * math.pi, 14)
    if 'toe_contact.' in name:
        # Pointed toe-tip tab, clear of the foot/toe FK cuffs.
        c = p + Vector((0, -.28, .28))
        w.line([c + Vector(v) for v in ((-.65, .12, 0), (-.65, -.2, 0),
                    (0, -.65, 0), (.65, -.2, 0), (.65, .12, 0))])
        w.line([c + Vector(v) for v in ((-.65, -.2, 0), (0, -.65, .25), (.65, -.2, 0))])
        return w.ellipse(c + Vector((side * .65, 0, 0)), (.32, .25), 'YZ',
                         .15 * math.pi, 1.15 * math.pi, 14)
    if 'ball_contact.' in name:
        # Pitch-only curved arrow at the forefoot; its depth arc reads in profile.
        c = p + Vector((side * .82, -.05, 1.1))
        w.ellipse(c, (.43, .34), 'YZ', -.3 * math.pi, 1.1 * math.pi, 22)
        w.line([c + Vector(v) for v in ((0, -.4, -.08), (0, -.55, -.2), (0, -.28, -.24))])
        return w.line([c + Vector(v) for v in ((-side * .4, .3, 0), (side * .25, .3, 0),
                                              (side * .1, .3, .16))])
    if 'wrist_pivot.' in name:
        # Translate-only pivot cross stays small and is distinct from both the
        # outer IK palm cage and the rotating contact control beside the hand.
        c = p + Vector((side * .28, -.3, -.15))
        for axis in range(3):
            a, b = c.copy(), c.copy()
            a[axis] -= .27; b[axis] += .27
            w.line((a, b))
        return w
    if 'hand_contact.' in name:
        c = p + Vector((side * .93, 0, -.65))
        w.ellipse(c, (.36, .5), 'XZ', -.1 * math.pi, 1.6 * math.pi, 24)
        w.ellipse(c, (.36, .5), 'YZ', -.1 * math.pi, 1.6 * math.pi, 24)
        return w.line([c + Vector(v) for v in ((.05, 0, -.47), (.22, 0, -.6), (.3, 0, -.37))])
    if 'wing_' in name:
        c = p + Vector((side * .4, 1.15, .15))
        w.line([c + Vector(v) for v in ((0, 0, -.5), (side * .5, .35, .1),
                                       (0, .55, .7), (-side * .3, .2, .1))], True)
        return w.line([c + Vector(v) for v in ((0, 0, -.5), (0, -.3, .1), (0, .55, .7))])
    if control_collection(name) == 'Armor':
        index = joint_map[name]
        low, high = bounds[f'Bone_{index:03}_Display']
        c = (low + high) / 2
        # Tabs sit just in front of their actual armor, with side-facing return edges.
        c.y = low.y - .16
        width = min(.48, max(.2, (high.x - low.x) * .3))
        height = .28 if 'foot_' in name else .38
        w.line([c + Vector(v) for v in ((-width, 0, 0), (-width * .55, 0, height),
                    (width * .55, 0, height), (width, 0, 0), (0, 0, -height))], True)
        return w.line([c + Vector(v) for v in ((0, 0, -height), (0, -.32, 0), (0, 0, height))])
    if 'foot.' in name or 'toe.' in name:
        low, high = bounds[f'Bone_{joint_map[name]:03}_Display']
        c = (low + high) / 2
        c.z = high.z + .16
        w.ellipse(c, ((high.x - low.x) / 2 + .14, (high.y - low.y) / 2 + .1), segments=20)
        w.ellipse(c, ((high.x - low.x) / 2 + .14, .22), 'XZ', 0, math.pi, 10)
        return w.ellipse(c, ((high.y - low.y) / 2 + .1, .22), 'YZ', 0, math.pi, 10)
    # Limb FK cuffs: place them along the segment rather than at crowded joint pivots.
    dz = -.45 if 'upper_arm.' in name else -.7 if 'forearm.' in name else -.6 if 'thigh.' in name else -.9 if 'shin.' in name else .22
    rx, ry = ((.82, .92) if any(t in name for t in ('thigh.', 'shin.')) else
              (.62, .72) if 'hand_fk.' in name else (.76, .84))
    c = p + Vector((0, 0, dz))
    w.ellipse(c, (rx, ry), segments=28)
    # Only a short front arc is added: readable in front without a cage of circles.
    w.ellipse(c + Vector((0, -ry, 0)), (rx, .22), 'XZ', 0, math.pi, 12)
    return w.ellipse(c + Vector((side * rx, 0, 0)), (ry, .22), 'YZ', 0, math.pi, 12)


def setup_widgets(rig):
    assert rig.get('model') == 'Weltall', 'Widgets are specific to the original Weltall mesh'
    bounds = rest_mesh_bounds(rig)
    joint_map = {name: int(index) for index, name in json.loads(rig['original_joint_map']).items()}
    shapes = bpy.data.collections.new('Weltall control shapes')
    bpy.context.scene.collection.children.link(shapes)
    shapes.hide_render = True
    for obj in bpy.data.objects:
        if obj.name.startswith('WGT-'):
            obj.hide_select = True
    groups = {name: rig.data.collections.get(name) or rig.data.collections.new(name)
              for name in ('Body', 'FK arms', 'FK legs', 'IK', 'Contacts', 'Wings', 'Armor', 'Mechanism')}
    groups['Mechanism'].is_visible = False
    counts = {}
    for p in rig.pose.bones:
        bone = p.bone
        if not p.name.startswith('CTRL-') or p.name in ('CTRL-palm.L', 'CTRL-palm.R'):
            bone.hide_select = True
            for collection in list(bone.collections):
                collection.unassign(bone)
            groups['Mechanism'].assign(bone)
            continue
        name = p.name
        group = control_collection(name)
        for collection in list(bone.collections):
            collection.unassign(bone)
        groups[group].assign(bone)
        bone.hide_select = False
        counts[group] = counts.get(group, 0) + 1
        wire = _widget(rig, name, bounds, joint_map)
        mesh = bpy.data.meshes.new('WGT-Weltall-' + name[5:])
        inverse = bone.matrix_local.inverted()
        mesh.from_pydata([inverse @ v for v in wire.vertices], wire.edges, [])
        obj = bpy.data.objects.new(mesh.name, mesh)
        shapes.objects.link(obj)
        obj.hide_render = True
        obj.hide_set(True)
        obj.hide_select = True
        p.custom_shape = obj
        p.custom_shape_transform = None
        p.use_custom_shape_bone_size = False
        p.custom_shape_scale_xyz = (1, 1, 1)
        p.custom_shape_translation = (0, 0, 0)
        p.custom_shape_rotation_euler = (0, 0, 0)
        p.custom_shape_wire_width = (1.6 if name == 'CTRL-chest' else
                                     2.5 if group in ('Body', 'IK') else
                                     2.1 if group == 'Contacts' else 1.6)
        color = (.13, .46, .95) if name.endswith('.L') else (.95, .21, .15) if name.endswith('.R') else (.9, .67, .14)
        p.color.palette = 'CUSTOM'
        p.color.custom.normal = color
        p.color.custom.select = (1.0, .69, .18)
        p.color.custom.active = (1.0, .95, .65)
        p.color.custom.show_colored_constraints = False
        p.lock_scale = (True, True, True)
        # Keep native translation where source motion intentionally uses it. The
        # two sides share permissions so flipped poses remain completely editable.
        sliding = name == 'CTRL-head' or any(t in name for t in ('knee_armor.', 'thigh_armor.', 'skirt.'))
        translating = name in ('CTRL-root', 'CTRL-body', 'CTRL-hips', 'CTRL-pelvis') or group == 'IK' or sliding
        if group != 'Contacts':  # Mechanics owns the axis permissions of contact pivots.
            p.lock_location = (not translating,) * 3
            pole = any(t in name for t in ('elbow.', 'knee.'))
            p.lock_rotation = (pole,) * 3
            p.lock_rotations_4d = True
            p.lock_rotation_w = pole
    rig.lock_location = rig.lock_rotation = rig.lock_scale = (True, True, True)
    rig.lock_rotations_4d = True
    rig.lock_rotation_w = True
    rig['widget_revision'] = 2
    return {'controls': sum(counts.values()), 'collections': counts,
            'shapeSpace': 'Original mesh rest space; bone pivots and evaluation unchanged',
            'slidingControls': ['head', 'knee_armor.L/R', 'thigh_armor.L/R', 'skirt.L/R']}
