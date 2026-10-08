import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateDiscImage,readDiscFilesystem,extractFlatDiscFiles,SECTOR_SIZE} from '../vendor-disc/server/src/xeno/disc-index.js';
import {checkDiscFiles,checkPayload} from '../lib/disc.mjs';
import {discSources} from '../lib/disc-sources.mjs';

test('raw Disc 1 reader extracts selected payloads across sector boundaries',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weltall-disc-test-'));
  try {
    const image=path.join(dir,'synthetic.bin'),fd=fs.openSync(image,'w');
    const payload=Buffer.from(Array.from({length:3001},(_,i)=>i%251));
    try {
      fs.ftruncateSync(fd,305586*SECTOR_SIZE);
      fs.writeSync(fd,Buffer.from('XENOGEARS'),0,9,16*SECTOR_SIZE+24+0x28);
      fs.writeSync(fd,Buffer.from('DS01_XENOGEARS\0'),0,14,23*SECTOR_SIZE+24);
      const entry=Buffer.alloc(7);entry.writeUIntLE(100,0,3);entry.writeInt32LE(payload.length,3);
      fs.writeSync(fd,entry,0,7,24*SECTOR_SIZE+24+7*7);
      fs.writeSync(fd,payload,0,2048,100*SECTOR_SIZE+24);
      fs.writeSync(fd,payload,2048,payload.length-2048,101*SECTOR_SIZE+24);
    } finally {fs.closeSync(fd);}
    assert.equal(validateDiscImage(image).discNumber,1);
    assert.equal(readDiscFilesystem(image).root.files[0].flatIndex,7);
    const result=extractFlatDiscFiles({imagePath:image,outputDir:path.join(dir,'files'),flatIndexes:[7]});
    assert.equal(result.fileCount,1);
    assert.deepEqual(fs.readFileSync(path.join(dir,'files/0007.bin')),payload);
    assert.throws(()=>extractFlatDiscFiles({imagePath:image,outputDir:path.join(dir,'absent'),flatIndexes:[8]}),/not a readable file/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('unsupported sector layout is rejected before extraction',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weltall-invalid-disc-'));
  try {
    const image=path.join(dir,'wrong.iso');fs.writeFileSync(image,Buffer.alloc(2048));
    assert.throws(()=>validateDiscImage(image),/2,352-byte raw sectors/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

function sourceTree() {
  const root={ordinal:0,files:[],directories:[]};
  for(const row of discSources) {
    let directory=row.directoryOrdinal===0?root:root.directories.find(d=>d.ordinal===row.directoryOrdinal);
    if(!directory) {directory={ordinal:row.directoryOrdinal,files:[],directories:[]};root.directories.push(directory);}
    while(directory.files.length<=row.fileIndex) directory.files.push({flatIndex:-directory.files.length-1,size:1});
    directory.files[row.fileIndex]={flatIndex:row.flatIndex,size:row.logicalBytes};
  }
  return root;
}

test('disc metadata accepts only the 13 approved resource occurrences',()=>{
  const root=sourceTree(),rows=checkDiscFiles(root);
  assert.equal(rows.length,13);
  assert(rows.every(r=>r.workspacePath===`files/${String(r.flatIndex).padStart(4,'0')}.bin`));
  assert.equal(rows.find(r=>r.flatIndex===2926).id,'xg:d1:file-002926');
  root.directories.find(d=>d.ordinal===20).files[0].size++;
  assert.throws(()=>checkDiscFiles(root),/Unsupported Disc 1 resource layout/);
});

test('missing resource coordinates are rejected',()=>{
  const root=sourceTree();root.directories.find(d=>d.ordinal===21).files[0].flatIndex=999;
  assert.throws(()=>checkDiscFiles(root),/3149 is missing/);
});

test('resource byte lengths and hashes must both match',()=>{
  const bytes=Buffer.from('synthetic content'),row={flatIndex:1,logicalBytes:bytes.length,
    payloadSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  checkPayload(bytes,row);
  assert.throws(()=>checkPayload(Buffer.from('Synthetic content'),row),/checksum mismatch/);
  assert.throws(()=>checkPayload(bytes.subarray(0,2),row),/checksum mismatch/);
});
