import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { digest, freezeCanonical } from '../../../tools/flow/src/canonical.mjs';
import { RESEARCH_SOURCE_LIMITS, validateResearchSourcePacket } from '../../../tools/flow/src/research-source-packet.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = message => { const error = new Error(message); error.code = 'invalid_research_source'; throw error; };
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
  if (!validateResearchSourcePacket(packet)) fail('Research source packet failed safety or exact-byte validation. Credentials, unsafe paths and non-content-addressed reference URLs may be refused. Keep optional reference URLs outside supplied source text. Preserve the original files; rejected contents are not echoed.');
  return { packet, provenance };
}

