import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readDiscFilesystem,extractFlatDiscFiles} from '../vendor-disc/server/src/xeno/disc-index.js';
import {decodeBattleGearResourceGroup} from '../vendor-disc/server/src/content-build/battle-mecha-resources.js';
import {decodeBattleMechaAuxiliaryContract} from '../vendor-disc/server/src/content-build/battle-mecha-auxiliary-contract.js';
import {battleMechaAuxiliaryAssetId,decodeBattleMechaAuxiliaryResource} from '../vendor-disc/server/src/content-build/battle-mecha-auxiliary-resources.js';
import {discSources} from './disc-sources.mjs';

const hash = bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const context = row=>({discNumber:1,sourceId:row.id,directoryOrdinal:row.directoryOrdinal,
  fileIndex:row.fileIndex,flatIndex:row.flatIndex,logicalBytes:row.logicalBytes,
  sha256:row.payloadSha256,storageLayout:row.storageLayout});

export function checkDiscFiles(root) {
  const files=new Map();
  function visit(directory) {
    directory.files.forEach((entry,fileIndex)=>files.set(entry.flatIndex,{...entry,directoryOrdinal:directory.ordinal,fileIndex}));
    directory.directories.forEach(visit);
  }
  visit(root);
  return discSources.map(expected=>{
    const actual=files.get(expected.flatIndex);
    assert(actual,`Required disc file ${expected.flatIndex} is missing`);
    assert(actual.directoryOrdinal===expected.directoryOrdinal && actual.fileIndex===expected.fileIndex
      && actual.size===expected.logicalBytes,`Unsupported Disc 1 resource layout at file ${expected.flatIndex}`);
    return {...expected,id:`xg:d1:file-${String(expected.flatIndex).padStart(6,'0')}`,
      storageLayout:'ordinary',workspacePath:`files/${String(expected.flatIndex).padStart(4,'0')}.bin`};
  });
}

export function checkPayload(bytes,row) {
  assert(bytes.length===row.logicalBytes && hash(bytes)===row.payloadSha256,
    `Unsupported Disc 1 resource or damaged image: ${row.id ?? row.flatIndex} checksum mismatch`);
}

// Build the battle consumer inputs from each user's authenticated source bytes.
export function decodeBattleRecords(rows,readBytes) {
  const byIndex=new Map(rows.map(row=>[row.flatIndex,row]));
  const read=index=>{
    const row=byIndex.get(index);
    assert(row,`Required source ${index} is missing`);
    const bytes=readBytes(row);
    checkPayload(bytes,row);
    return {bytes,context:context(row)};
  };
  const model=read(2926),animation=read(2927),overlay=read(38);
  // The auxiliary contract also authenticates the executable consumer's identity.
  read(22);
  const contract=decodeBattleMechaAuxiliaryContract(overlay.bytes,overlay.context);
  const decoded=decodeBattleGearResourceGroup({gearId:0,modelBytes:model.bytes,modelContext:model.context,
    animationBytes:animation.bytes,animationContext:animation.context});
  assert(decoded.semantic.complete,'Incomplete Weltall battle resource');
  const primary=decoded.assets[0],gear=primary.data.gears[0],selections=new Map();
  for(const instruction of gear.animation.program.instructions.filter(i=>i.opcode===4)) {
    const selector=instruction.operands[0].signedValue,variant=instruction.argument;
    const nativeFileNumber=contract.loader.selectorBases[selector]+variant;
    assert(Number.isInteger(nativeFileNumber),'Unsupported Weltall auxiliary selector');
    const resourceId=battleMechaAuxiliaryAssetId(1,nativeFileNumber-1);
    const flatIndex=3149+nativeFileNumber-2;
    assert(byIndex.has(flatIndex),`Unapproved Weltall auxiliary ${nativeFileNumber}`);
    selections.set(`${selector}:${variant}`,{selector,variant,nativeFileNumber,resourceId});
  }
  gear.auxiliaryResources=[...selections.values()];
  primary.dependencies=gear.auxiliaryResources.map(({resourceId})=>({id:resourceId,role:'auxiliary-animation'}));
  // Retain the established action order so action names and merged strips remain stable.
  const records=[primary];
  for(const flatIndex of [3371,3188,3189,3190,3149]) {
    const source=read(flatIndex);
    const auxiliary=decodeBattleMechaAuxiliaryResource(source.bytes,source.context,contract);
    assert(auxiliary.semantic.complete,`Incomplete Weltall auxiliary ${flatIndex}`);
    records.push(auxiliary.assets[0]);
  }
  assert.equal(new Set(gear.auxiliaryResources.map(r=>r.resourceId)).size,5,'Unexpected Weltall auxiliary set');
  return records;
}

export function prepareDisc(imagePath,sourceFolder) {
  assert(!fs.existsSync(sourceFolder),`Source output already exists: ${sourceFolder}`);
  const {disc,root}=readDiscFilesystem(imagePath);
  assert.equal(disc.discNumber,1,'Weltall requires Xenogears Disc 1');
  const rows=checkDiscFiles(root);
  extractFlatDiscFiles({imagePath,outputDir:path.join(sourceFolder,'files'),flatIndexes:rows.map(r=>r.flatIndex)});
  const readBytes=row=>fs.readFileSync(path.join(sourceFolder,row.workspacePath));
  for(const row of rows) checkPayload(readBytes(row),row);
  const source={discNumber:1,fileName:disc.fileName,bytes:disc.bytes,sectorCount:disc.sectorCount,
    format:'2352-byte raw BIN',authenticatedResourceCount:rows.length};
  fs.writeFileSync(path.join(sourceFolder,'source-index.json'),JSON.stringify({source,files:rows},null,2)+'\n');
  const records=decodeBattleRecords(rows,readBytes);
  const sourceAudit={canonicalModelSha256:rows.find(r=>r.flatIndex===2926).payloadSha256,
    source,resources:rows.map(({id,directoryOrdinal,fileIndex,flatIndex,logicalBytes,payloadSha256})=>
      ({id,directoryOrdinal,fileIndex,flatIndex,bytes:logicalBytes,sha256:payloadSha256})),
    note:'All required resources authenticated against the supported Disc 1. Scene08 uses explicit reference retargeting.'};
  return {source,records,sourceAudit};
}
