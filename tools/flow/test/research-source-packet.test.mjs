import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readResearchSourcePacket, validateResearchSourcePacket } from '../src/research-source-packet.mjs';

test('plain source files become exact immutable content-addressed research bytes without local paths', t => {
 const dir=mkdtempSync(join(tmpdir(),'source-packet-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'notes.txt'), content='A bounded observation.\n'; writeFileSync(file,content);
 const result=readResearchSourcePacket({question:'What follows?',sources:[file]});
 const source=result.packet.sources[0];
 assert.equal(source.content,content); assert.equal(source.digest,'sha256:'+createHash('sha256').update(content).digest('hex'));
 assert.equal(source.uri,'urn:sha256:'+source.digest.slice(7)); assert.equal(JSON.stringify(result.packet).includes(dir),false);
 assert.equal(validateResearchSourcePacket(result.packet),true); assert.ok(Object.isFrozen(result.packet));
 writeFileSync(file,'A changed observation.'); assert.notEqual(readResearchSourcePacket({question:'What follows?',sources:[file]}).packet.packet_digest,result.packet.packet_digest);
 assert.equal(validateResearchSourcePacket({...result.packet,sources:[{...source,content:'tampered'}]}),false);
});

test('source aliases, malformed UTF-8, oversize and unsafe text refuse without echoing source material',t=>{
 const dir=mkdtempSync(join(tmpdir(),'source-packet-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'source'); writeFileSync(file,'safe'); const alias=join(dir,'alias'); symlinkSync(file,alias);
 assert.throws(()=>readResearchSourcePacket({question:'Question',sources:[alias]}),/regular|alias/);
 writeFileSync(file,Buffer.from([0xc0,0xaf])); assert.throws(()=>readResearchSourcePacket({question:'Question',sources:[file]}),/UTF-8/);
 writeFileSync(file,'x'.repeat(32769)); assert.throws(()=>readResearchSourcePacket({question:'Question',sources:[file]}),/32 KiB/);
 const secret='sk-'+ 'a'.repeat(40); writeFileSync(file,secret);
 assert.throws(()=>readResearchSourcePacket({question:'Question',sources:[file]}),error=>/safety/.test(error.message)&&!error.message.includes(secret));
});
