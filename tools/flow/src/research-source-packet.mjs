import { createHash } from 'node:crypto';
import { digest, isPlainRecord } from './canonical.mjs';
import { validateResearchInputSafety } from './evidence-safety.mjs';

export const RESEARCH_SOURCE_LIMITS = Object.freeze({ question_bytes: 4096, sources: 4, source_bytes: 32768, total_source_bytes: 131072 });
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => isPlainRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

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
