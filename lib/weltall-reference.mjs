import { bakeBattleReferences } from './battle-reference.mjs';
import { retargetScene08, SCENE08_MAP } from './reference-retarget.mjs';

export function weltallReferences(primary,sources,{records,sourceAudit}) {
  const battle=bakeBattleReferences(records),animations=[...battle.animations],coverage=[...battle.coverage];
  const scene01=sources.find(s=>s.id==='weltall-scene-01').scene;
  const scene08=sources.find(s=>s.id==='weltall-scene-08').scene;
  const gaps=[];
  for(const [prefix,clips] of [['Scene01',scene01.animations],['Scene08',retargetScene08(primary,scene08)]]) {
    for(const clip of clips) {
      const partial=clip.status!=='complete';
      const name=`${prefix}_${String(clip.index).padStart(2,'0')}${partial?'_PARTIAL_missing_keyframe':''}`;
      animations.push({...clip,name,index:animations.length,status:'complete',referenceOnly:true});
      const record={name,source:prefix,animationId:clip.index,frames:clip.frames.length,
        originalStatus:clip.status,retargeted:prefix==='Scene08'};
      if(partial) {record.missingKeyframes=clip.unsupportedKeyframes;gaps.push(record);}
      coverage.push(record);
    }
  }
  return {animations,report:{referenceOnly:true,coverage,emptyBattleSlots:battle.emptySlots,
    sourceGaps:gaps,context:battle.context,
    retarget:{source:'scene08',canonicalToSourceNodes:SCENE08_MAP,
      method:'World-space bind-offset retarget onto the original canonical nodes; geometry and hierarchy unchanged.',
      sourceOnlyNodes:[15,16,30,51,52,53],note:'These six additional chest surfaces are absent from the canonical model.'},
    sourceAudit}};
}
