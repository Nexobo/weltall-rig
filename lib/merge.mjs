import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Animation channels address node indices. Only identical rigs/rest poses can
// share those channels without retargeting or changing the original hierarchy.
export function mergeAnimations(primary, sources) {
  const rig = scene => JSON.stringify({nodes:scene.nodes, scale:scene.modelConfig.embeddedScale});
  const expected = rig(primary), animations = [], clips = [], fingerprints = new Map();
  for(const {id,scene} of sources) {
    const compatible = rig(scene) === expected;
    for(const clip of scene.animations) {
      const name = `${id}/${clip.name}`;
      const record = {source:id,index:clip.index,name,status:clip.status,loop:clip.loop,
        runtimeDependencies:clip.runtimeDependencies ?? [],unsupportedOpcodes:clip.unsupportedOpcodes ?? [],
        unsupportedTrackModes:clip.unsupportedTrackModes ?? [],unsupportedKeyframes:clip.unsupportedKeyframes ?? [],
        scriptErrors:clip.scriptErrors ?? []};
      if(!compatible) record.omittedReason = 'incompatible-hierarchy';
      else if(clip.status !== 'complete') record.omittedReason = clip.status;
      else {
        const key = createHash('sha256').update(JSON.stringify({frames:clip.frames,fps:clip.fps,
          ticks:clip.ticks,loop:clip.loop,events:clip.events ?? []})).digest('hex');
        if(fingerprints.has(key)) record.exportedAs = fingerprints.get(key);
        else {
          fingerprints.set(key,name);
          animations.push({...clip,name});
          record.exportedAs = name;
        }
      }
      clips.push(record);
    }
  }
  assert(new Set(animations.map(c=>c.name)).size===animations.length, 'Duplicate merged clip names');
  return {animations,clips};
}
