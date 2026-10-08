"""Consolidate identical exported Blender actions and their preview timeline."""
import hashlib

import bpy


def action_fingerprint(action):
    """Compare complete layered action motion, independently of clip names."""
    slots = {slot.handle: slot.identifier for slot in action.slots}
    digest = hashlib.sha256()

    def add(value):
        digest.update(repr(value).encode('utf-8'))
        digest.update(b'\n')

    add((tuple(action.frame_range), action.use_frame_range,
         action.frame_start, action.frame_end, action.use_cyclic))
    for layer in action.layers:
        for strip in layer.strips:
            add(strip.type)
            for bag in sorted(strip.channelbags, key=lambda b: slots[b.slot_handle]):
                add(slots[bag.slot_handle])
                for curve in sorted(bag.fcurves, key=lambda c: (c.data_path, c.array_index)):
                    assert not curve.modifiers, 'Export animation curves must be unmodified'
                    add((curve.data_path, curve.array_index, curve.extrapolation,
                         curve.mute, curve.auto_smoothing))
                    add(tuple((tuple(key.co), key.interpolation,
                               tuple(key.handle_left), tuple(key.handle_right),
                               key.handle_left_type, key.handle_right_type,
                               key.easing, key.back, key.amplitude, key.period)
                              for key in curve.keyframe_points))
                    add(tuple(tuple(point.co) for point in curve.sampled_points))
            add('end strip')
        add('end layer')
    return digest.hexdigest()


def deduplicate_actions(schedule, tracks, scene):
    """Return (compact schedule, counts), retaining every source ID as an alias.

    Schedule records contain source, action, start, end and samples. Tracks are
    the export's NLA preview tracks; their rest-pose strips remain untouched.
    """
    if not schedule:
        return [], {'sourceClips': 0, 'uniqueClips': 0, 'duplicateClips': 0,
                    'unusedSourceActionsRemoved': 0}

    actions = {action.name: action for action in bpy.data.actions if action.library is None}
    fingerprints, replacements, unique = {}, {}, []
    cursor = schedule[0]['start']
    for record in schedule:
        action = actions[record['action']]
        fingerprint = action_fingerprint(action)
        aliases = record.get('sourceAliases', [record['source']])
        if fingerprint in fingerprints:
            kept = fingerprints[fingerprint]
            kept['sourceAliases'].extend(aliases)
            replacements[record['action']] = kept['action']
            continue
        kept = dict(record, start=cursor,
                    end=cursor + record['end'] - record['start'],
                    sourceAliases=list(aliases))
        fingerprints[fingerprint] = kept
        unique.append(kept)
        cursor += record['end'] - record['start'] + 1

    positions = {record['action']: record for record in unique}
    for track in tracks:
        for strip in list(track.strips):
            if strip.action and strip.action.library is None and strip.action.name in replacements:
                track.strips.remove(strip)
        for strip in track.strips:
            if strip.action and strip.action.library is None and strip.action.name in positions:
                strip.frame_start_ui = positions[strip.action.name]['start']

    source_names = {alias for record in schedule
                    for alias in record.get('sourceAliases', [record['source']])}
    for marker in list(scene.timeline_markers):
        if marker.name in source_names:
            scene.timeline_markers.remove(marker)
    for record in unique:
        scene.timeline_markers.new(record['source'], frame=record['start'])

    for name in replacements:
        action = actions[name]
        # A fake user protects exported actions, but is not another animation user.
        if action.library is None and action.users == int(action.use_fake_user):
            bpy.data.actions.remove(action)
    # The rig builder can leave imported GLB actions alongside its retargeted
    # actions. Only those known source names with no real users are disposable.
    export_names = {record['action'] for record in schedule}
    removed_sources = 0
    for name in source_names - export_names:
        action = actions.get(name)
        if action and action.library is None and action.users == int(action.use_fake_user):
            bpy.data.actions.remove(action)
            removed_sources += 1
    scene.frame_end = unique[-1]['end']
    source_count = sum(len(record['sourceAliases']) for record in unique)
    return unique, {'sourceClips': source_count, 'uniqueClips': len(unique),
                    'duplicateClips': source_count - len(unique),
                    'unusedSourceActionsRemoved': removed_sources}
