import { createBattleModelAnimation } from '../vendor-battle/shared/runtime/opening-battle-animation.js';

const BASE_AUX = 'xg:d1:asset:battle:mecha-auxiliary-001';

function player(records) {
  const resources = new Map(records.map(r=>[r.id,r]));
  const gear = records[0].data.gears[0];
  return createBattleModelAnimation({
    actors:[{actorId:0,kind:'mecha',gearId:0,resourceId:records[0].id,position:{x:0,y:0,z:0}}],resources,
    initialCamera:{eye:[1000,-800,1400],at:[0,-250,0],up:[0,-4096,0]},environmentScale:4096,
    terrainHeight:()=>0,auxiliaryResources:gear.auxiliaryResources,
    slotLayout:new Map([[0,{midpoint:[600,0],branchFlag:true}]]),
    getActionContext:()=>({battleMode:0,statusDamageMask:0,targets:[{damageClass:0,isGear:true}]}),
    externalActors:{state:()=>({position:[1200,0,0],home:[1200,0,0],height:475,radius:153,state38:0}),dispatchAnimation:()=>{}},
    dispatchTargetEvent:()=>{},partyGearActorIds:[0],shadowColor:[0,0,0],
  });
}

function capture(records,id, auxiliary = null) {
  const gear = records[0].data.gears[0];
  const runtime=player(records);
  runtime.referencePrepare(auxiliary ?? (id===29 ? null : BASE_AUX));
  // Root67 is the shared effect-motion body; root48 supplies its native effect selector.
  if(id===67 && !auxiliary) runtime.play({actorId:0,targetActorId:1,animationId:48});
  runtime.play({actorId:0,targetActorId:1,animationId:id});
  const frames=[];
  let loopTicks=0, settledTicks=0, end=null;
  for(let tick=0;tick<=1800;tick++) {
    const actor=runtime.frame().actors.find(a=>a.actorId===0);
    const pose=structuredClone(actor.pose);
    pose.rootScale = pose.rootScale.map(v=>v*actor.modelScale/gear.animation.modelScale);
    if(!actor.visible) pose.visible.fill(false);
    frames.push({...pose,tick});
    const state=runtime.referenceState(), waiting=runtime.inspect().actors.find(a=>a.actorId===0).waitingFor;
    if(state.loopDuration && !state.finiteTracks && (!state.active || waiting==='tracks')) {
      loopTicks++;
      if(loopTicks>state.loopDuration){end='one-loop';break;}
    } else loopTicks=0;
    if(!state.active && !state.finiteTracks && !state.loopDuration && !state.pendingMotion) {
      if(++settledTicks>=2){end='finished';break;}
    } else settledTicks=0;
    for(const p of runtime.inspect().pending) runtime.completePresentation(p.id);
    runtime.step();
  }
  if(!end) throw Error(`Reference capture did not finish: ${auxiliary ?? 'base'} animation ${id}`);
  return {frames,end};
}

export function bakeBattleReferences(records) {
  if(!Array.isArray(records) || records.length!==6) throw Error('Weltall reference baking requires its six locally decoded battle records');
  const gear = records[0].data.gears[0];
  const animations=[],coverage=[];
  function add(name,id,auxiliary=null) {
    const {frames,end}=capture(records,id,auxiliary);
    animations.push({index:animations.length,name,fps:30,ticks:frames.at(-1).tick,frames,
      status:'complete',loop:false,events:[],runtimeDependencies:[],
      referenceOnly:true});
    coverage.push({name,animationId:id,source:auxiliary ?? records[0].id,frames:frames.length,end});
  }
  const emptySlots=[];
  for(const root of gear.animation.container.animationTable.roots) {
    if(!root.present){emptySlots.push(root.animationId);continue;}
    add(`Battle_${String(root.animationId).padStart(2,'0')}`,root.animationId);
  }
  for(const record of records.slice(1)) {
    const auxiliary=record.data.gears[0];
    for(const [index,offset] of (auxiliary.storedProgram?.roots ?? []).entries()) {
      if(offset===null) continue;
      add(`Aux${auxiliary.nativeFileNumber}_${String(index).padStart(2,'0')}`,80+index,record.id);
    }
  }
  return {animations,coverage,emptySlots,context:{fps:30,target:[1200,0,0],groundY:0,
    presentation:'Sound/FX requests acknowledged immediately; target reactions excluded; camera omitted.',
    loops:'One full cycle. Finite tracks sampled through completion.',
    resources:records.map(r=>({id:r.id,provenance:r.provenance}))}};
}
