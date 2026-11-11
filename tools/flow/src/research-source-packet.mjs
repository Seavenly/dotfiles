import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { digest, freezeCanonical, isPlainRecord } from './canonical.mjs';
import { validateResearchInputSafety } from './evidence-safety.mjs';

export const RESEARCH_SOURCE_LIMITS = Object.freeze({ question_bytes: 4096, sources: 4, source_bytes: 32768, total_source_bytes: 131072 });
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = message => { const error = new Error(message); error.code = 'invalid_research_source'; throw error; };
const exact = (value, keys) => isPlainRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function safeText(bytes) {
  try { const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (Buffer.compare(Buffer.from(value),bytes)) fail('Use exact UTF-8 text.'); return value; }
  catch { fail('Sources must contain valid UTF-8 text.'); }
}

/** Snapshot bounded local bytes. Paths are local provenance, never source authority. */
export function readResearchSourcePacket({ question, sources, cwd = process.cwd() }) {
  if (typeof question !== 'string' || !question.trim() || Buffer.byteLength(question) > RESEARCH_SOURCE_LIMITS.question_bytes) fail('Use one nonempty question of at most 4 KiB.');
  if (!Array.isArray(sources) || !sources.length || sources.length > 4) fail('Select one through four source files.');
  const provenance = [], entries = [];
  for (const input of sources) {
    const path = resolve(cwd, input);
    let fd;
    try {
      const before = lstatSync(path);
      if (!before.isFile() || realpathSync(path) !== path) fail('Source must be a regular canonical file; aliases are unsupported.');
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) fail('Source file identity changed during selection.');
      if (!stat.size || stat.size > RESEARCH_SOURCE_LIMITS.source_bytes) fail('Each source must contain text of at most 32 KiB.');
      const buffer = Buffer.alloc(RESEARCH_SOURCE_LIMITS.source_bytes + 1);
      let length = 0, count;
      while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length-length, null)) > 0) length += count;
      const after = fstatSync(fd), current = lstatSync(path);
      if (length !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.mtimeMs !== stat.mtimeMs || current.dev !== stat.dev || current.ino !== stat.ino || realpathSync(path) !== path) fail('Source changed while reading; preview again.');
      const bytes = buffer.subarray(0,length), content = safeText(bytes), sha = hash(bytes);
      if (entries.some(source => source.digest === sha)) fail('Select distinct source contents; duplicate bytes are not independent sources.');
      entries.push({ id: `source:${sha.slice(7)}`, uri: `urn:sha256:${sha.slice(7)}`, digest: sha, size_bytes: length, content });
      provenance.push({ path, digest: sha, size_bytes: length });
    } catch (error) {
      if (error.code === 'invalid_research_source') throw error;
      fail('Source is unavailable or not a regular canonical readable file; no source contents were retained.');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const identity = { schema: 'flow.research-source-packet/v1', question: { id: `question:${digest(question).slice(7)}`, text: question }, sources: entries };
  const packet = freezeCanonical({ ...identity, packet_digest: digest(identity) });
  if (!validateResearchSourcePacket(packet)) fail('Research source packet failed safety or exact-byte validation. Preserve the original files and select safe bounded text; contents are not echoed.');
  return { packet, provenance };
}

/** Validate the same supplied bytes again at preparation/transport, without filesystem reads. */
export function validateResearchSourcePacket(packet) {
  try {
    if (!exact(packet,['schema','question','sources','packet_digest']) || packet.schema !== 'flow.research-source-packet/v1' || !exact(packet.question,['id','text'])) return false;
    const text = packet.question.text;
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text)>4096 || packet.question.id !== `question:${digest(text).slice(7)}` || !Array.isArray(packet.sources) || !packet.sources.length || packet.sources.length>4) return false;
    let total=0; const seen=new Set();
    for (const source of packet.sources) {
      if (!exact(source,['id','uri','digest','size_bytes','content']) || typeof source.content !== 'string') return false;
      const bytes=Buffer.from(source.content), sha=hash(bytes); total+=bytes.length;
      if (!bytes.length || bytes.length>32768 || source.size_bytes!==bytes.length || source.digest!==sha || source.id!==`source:${sha.slice(7)}` || source.uri!==`urn:sha256:${sha.slice(7)}` || seen.has(sha)) return false;
      seen.add(sha);
    }
    const {packet_digest,...identity}=packet;
    return total<=131072 && digest(identity)===packet_digest && validateResearchInputSafety(researchPacketSafetyValue(packet)).accepted===true;
  } catch { return false; }
}
export function researchPacketSafetyValue(packet) {
  return { schema: packet.schema, question: { subject_id: packet.question.id, text: packet.question.text }, sources: packet.sources.map(({id,...source})=>({subject_id:id,...source})), packet_digest:packet.packet_digest };
}
