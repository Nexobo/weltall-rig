import assert from 'node:assert/strict';
import { MathUtils } from '@gltf-transform/core';

// Canonical node -> scene08 counterpart, matched by control hierarchy and
// world-space mesh bounds. Source08's six extra chest surfaces have no counterpart.
export const SCENE08_MAP = [0,1,2,5,4,19,20,22,6,7,10,9,24,25,26,11,12,32,33,34,36,37,38,39,40,41,42,43,44,45,13,14,29,31,17,18,47,3,23,21,48,8,49,27,28,35,55,56,46,50,54];
const multiply=(a,b)=>Array.from({length:16},(_,i)=>{const row=i%4,col=Math.floor(i/4);let v=0;for(let k=0;k<4;k++)v+=a[k*4+row]*b[col*4+k];return v;});
function inverse(m) {
  const a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10];
  const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  assert(Math.abs(det)>1e-10,'Reference retarget encountered a singular pose');
  const r=[(e*i-f*h)/det,(f*g-d*i)/det,(d*h-e*g)/det,0,
    (c*h-b*i)/det,(a*i-c*g)/det,(b*g-a*h)/det,0,
    (b*f-c*e)/det,(c*d-a*f)/det,(a*e-b*d)/det,0,0,0,0,1];
  for(let k=0;k<3;k++)r[12+k]=-(r[k]*m[12]+r[4+k]*m[13]+r[8+k]*m[14]);
  return r;
}
function quaternion(rotation) {
  const [x,y,z]=rotation.map(v=>v*Math.PI/4096),cx=Math.cos(x),cy=Math.cos(y),cz=Math.cos(z),sx=Math.sin(x),sy=Math.sin(y),sz=Math.sin(z);
  return [sx*cy*cz+cx*sy*sz,cx*sy*cz-sx*cy*sz,cx*cy*sz+sx*sy*cz,cx*cy*cz-sx*sy*sz];
}
function rotation(q) {
  const [x,y,z,w]=q;
  const m11=1-2*(y*y+z*z),m12=2*(x*y-z*w),m13=2*(x*z+y*w),m22=1-2*(x*x+z*z),m23=2*(y*z-x*w),m32=2*(y*z+x*w),m33=1-2*(x*x+y*y);
  const angles=Math.abs(m13)<0.9999999 ? [Math.atan2(-m23,m33),Math.asin(Math.max(-1,Math.min(1,m13))),Math.atan2(-m12,m11)]
    : [Math.atan2(m32,m22),Math.asin(Math.max(-1,Math.min(1,m13))),0];
  return angles.map(v=>v*2048/Math.PI);
}
function matrices(nodes,frame=null) {
  const result=[];
  function at(i) {
    if(result[i])return result[i];
    const n=nodes[i],m=[];
    MathUtils.compose(frame?.translations[i]??n.translation,quaternion(frame?.rotations[i]??n.rotation),frame?.scales[i]??[1,1,1],m);
    return result[i]=n.parent<0?m:multiply(at(n.parent),m);
  }
  nodes.forEach((_,i)=>at(i));return result;
}

export function retargetScene08(primary,source) {
  assert(primary.nodes.length===51 && source.nodes.length===57,'Unexpected Weltall source hierarchy');
  assert(new Set(SCENE08_MAP).size===51,'Retarget map is not one-to-one');
  const targetBind=matrices(primary.nodes),sourceBind=matrices(source.nodes);
  const offsets=SCENE08_MAP.map((src,i)=>multiply(inverse(sourceBind[src]),targetBind[i]));
  return source.animations.map(clip=>({...clip,referenceRetarget:true,frames:clip.frames.map(frame=>{
    const world=matrices(source.nodes,frame);
    const desired=SCENE08_MAP.map((src,i)=>multiply(world[src],offsets[i]));
    const rotations=[],translations=[],scales=[];
    primary.nodes.forEach((node,i)=>{
      const local=node.parent<0?desired[i]:multiply(inverse(desired[node.parent]),desired[i]);
      const t=[],q=[],s=[];MathUtils.decompose(local,t,q,s);
      translations.push(t);rotations.push(rotation(q));scales.push(s);
    });
    return {...frame,rotations,translations,scales,visible:SCENE08_MAP.map(i=>frame.visible[i])};
  })}));
}
