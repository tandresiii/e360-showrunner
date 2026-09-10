// ════════════════════════════════════════════════════════════════════════════
// lib/mediaprobe.js — pixel specs and codec from a file's OWN bytes, bounded
// ────────────────────────────────────────────────────────────────────────────
// Tom (2026-09-10): "would love to be able to see pixel specs, codec, etc."
// for files sitting in Dropbox — WITHOUT ingesting them. Dropbox's media_info
// covers dimensions for common photos/videos when it feels like computing
// them; codec, ProRes flavour and everything else need the container headers
// read directly. This module does that with RANGE reads only, zero
// dependencies (the WebDAV-client precedent: a code path that touches remote
// bytes should be readable end to end), and a HARD byte budget.
//
// THE BUDGET IS THE CONTRACT. A probe may fetch at most PROBE_MAX_BYTES
// (8 MB) across at most PROBE_MAX_REQUESTS range requests, and it checks
// BEFORE each request — a moov atom that declares itself bigger than the
// remaining budget is an honest refusal, never a download. Remove the check
// and the mutation suite goes red on the fake's request log.
//
// HONESTY RULE: only values PARSED FROM BYTES leave this module. Anything it
// cannot parse is a typed 'PROBE_UNREADABLE' — "couldn't read the container"
// — never a guess, never a default. The caller caches per file REVISION, so
// a probe happens once per rev, ever.
//
// What it reads:
//   PNG   IHDR width/height.
//   JPEG  SOF marker width/height (EXIF blocks skipped by segment walk).
//   GIF   logical-screen width/height.
//   MP4 / MOV (ISO BMFF / QuickTime)
//         top-level box walk by 16-byte ranged header reads — hopping OVER
//         mdat instead of downloading it, which is how a tail-moov file
//         (mdat first, moov last) costs a handful of tiny reads rather than
//         the whole file. Then, inside moov: tkhd/stsd for track pixels and
//         the codec fourcc, mvhd for duration, mdhd+stts for fps when the
//         table is trivially cheap (one entry), hdlr to spot an audio track.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const PROBE_MAX_BYTES = 8 * 1024 * 1024;
const PROBE_MAX_REQUESTS = 12;

// fourcc -> the name a human says out loud. Unknown tags surface AS the tag —
// 'xd5b' on the row is honest; 'H.264' guessed from nothing is not.
const CODEC_NAMES = {
  avc1: 'H.264', avc3: 'H.264',
  hvc1: 'H.265 (HEVC)', hev1: 'H.265 (HEVC)',
  ap4h: 'ProRes 4444', ap4x: 'ProRes 4444 XQ',
  apch: 'ProRes 422 HQ', apcn: 'ProRes 422', apcs: 'ProRes 422 LT',
  apco: 'ProRes 422 Proxy',
  mp4v: 'MPEG-4', vp09: 'VP9', av01: 'AV1', mjpa: 'Motion JPEG'
};

function unreadable(why) {
  const e = new Error(`Couldn't read the container${why ? ' — ' + why : ''}. ` +
    'Only what the bytes themselves say is ever shown; this file says nothing this probe understands.');
  e.code = 'PROBE_UNREADABLE';
  return e;
}
function overBudget(why) {
  const e = new Error(`Probe stopped inside its byte budget${why ? ' — ' + why : ''} ` +
    `(cap ${Math.round(PROBE_MAX_BYTES / 1048576)} MB / ${PROBE_MAX_REQUESTS} range reads per file).`);
  e.code = 'PROBE_BUDGET';
  return e;
}

const ascii = (buf, a, b) => buf.toString('latin1', a, b);
const u64 = (buf, o) => Number(buf.readBigUInt64BE(o));

// ── the probe ───────────────────────────────────────────────────────────────
// `size` is the file's reported byte length; `fetchRange(start, end)` returns
// a Buffer for the INCLUSIVE range (HTTP-Range semantics). The budget lives
// here, around every fetch, so no parser branch can out-spend it.
async function probeSpecs({ size, fetchRange }) {
  const total = Number(size) || 0;
  if (total <= 0) throw unreadable('the file is empty');

  let spent = 0;
  let requests = 0;
  async function take(start, end) {
    const last = Math.min(end, total - 1);
    if (last < start) throw unreadable('range past the end of the file');
    const len = last - start + 1;
    // the check comes BEFORE the request — this line IS the byte cap
    if (spent + len > PROBE_MAX_BYTES) throw overBudget(`${len} more bytes would pass the cap`);
    if (requests + 1 > PROBE_MAX_REQUESTS) throw overBudget('too many range reads');
    requests += 1;
    spent += len;
    const buf = await fetchRange(start, last);
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw unreadable('the range read came back empty');
    return buf;
  }

  const head = await take(0, Math.min(64 * 1024, total) - 1);

  // PNG — signature, then IHDR is mandated first: width/height at fixed spots.
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
    if (ascii(head, 12, 16) !== 'IHDR') throw unreadable('PNG without a leading IHDR');
    return { kind: 'still', container: 'PNG', codec: 'PNG', codec_tag: 'png',
             w: head.readUInt32BE(16), h: head.readUInt32BE(20),
             duration_s: null, fps: null, audio: false };
  }
  // GIF — dimensions live in the fixed header.
  if (head.length >= 10 && /^GIF8[79]a/.test(ascii(head, 0, 6))) {
    return { kind: 'still', container: 'GIF', codec: 'GIF', codec_tag: 'gif',
             w: head.readUInt16LE(6), h: head.readUInt16LE(8),
             duration_s: null, fps: null, audio: false };
  }
  // JPEG — walk segments to a start-of-frame marker; EXIF/APPn blocks are
  // length-prefixed, so a fat embedded thumbnail is skipped, not downloaded.
  if (head.length >= 4 && head.readUInt16BE(0) === 0xffd8) {
    let buf = head;
    let i = 2;
    for (let guard = 0; guard < 256; guard += 1) {
      // grow the window (within budget) when the SOF sits past what we hold
      if (i + 9 > buf.length) {
        if (buf.length >= total) throw unreadable('JPEG ended before a size marker');
        const more = await take(buf.length, Math.min(buf.length + 512 * 1024, total) - 1);
        buf = Buffer.concat([buf, more]);
      }
      if (buf[i] !== 0xff) throw unreadable('JPEG marker walk lost sync');
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda || marker === 0xd9) throw unreadable('JPEG carries no size marker before its image data');
      const segLen = buf.readUInt16BE(i + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { kind: 'still', container: 'JPEG', codec: 'JPEG', codec_tag: 'jpeg',
                 w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5),
                 duration_s: null, fps: null, audio: false };
      }
      i += 2 + segLen;
    }
    throw unreadable('JPEG marker walk gave up');
  }
  // ISO BMFF (MP4 / MOV) — 'ftyp' as the first box is the signature.
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    const container = /^qt/.test(brand) ? 'QuickTime' : 'MP4';
    const moov = await findMoov(head, total, take);
    return parseMoov(moov, container);
  }
  throw unreadable('no signature this probe recognizes (PNG, JPEG, GIF, MP4/MOV)');
}

// Walk the TOP-LEVEL boxes by header alone. Each hop reads 16 bytes at the
// next boundary (free when the head window already covers it), so an mdat of
// any size costs one 16-byte read to step over — the whole reason a
// moov-at-the-tail file probes in a few KB.
async function findMoov(head, total, take) {
  let pos = 0;
  for (let guard = 0; guard < 32; guard += 1) {
    if (pos + 8 > total) break;
    const hdr = pos + 16 <= head.length ? head.subarray(pos, pos + 16)
                                        : await take(pos, Math.min(pos + 15, total - 1));
    const size32 = hdr.readUInt32BE(0);
    const type = ascii(hdr, 4, 8);
    let boxSize = size32;
    if (size32 === 1) {
      if (hdr.length < 16) throw unreadable('truncated 64-bit box header');
      boxSize = u64(hdr, 8);
    } else if (size32 === 0) {
      boxSize = total - pos;                 // "to end of file"
    }
    if (boxSize < 8) throw unreadable('nonsense box size in the container walk');
    if (type === 'moov') {
      if (pos + boxSize <= head.length) return head.subarray(pos, pos + boxSize);
      // the budget check inside take() is what refuses a moov too big to read
      return take(pos, pos + boxSize - 1);
    }
    pos += boxSize;
  }
  throw unreadable('no moov atom found (is this a fragmented or truncated file?)');
}

// Iterate the child boxes of buf[start..end): [{type, a, b}] with a..b the
// PAYLOAD range. Non-recursive by design — callers descend on purpose.
function children(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size32 = buf.readUInt32BE(pos);
    const type = ascii(buf, pos + 4, pos + 8);
    let boxSize = size32;
    let hdrLen = 8;
    if (size32 === 1) { if (pos + 16 > end) break; boxSize = u64(buf, pos + 8); hdrLen = 16; }
    else if (size32 === 0) boxSize = end - pos;
    if (boxSize < hdrLen || pos + boxSize > end) break;
    out.push({ type, a: pos + hdrLen, b: pos + boxSize });
    pos += boxSize;
  }
  return out;
}
const child = (buf, list, type) => list.find((c) => c.type === type) || null;

function parseMoov(moov, container) {
  const top = children(moov, 8, moov.length);      // past the moov header itself
  if (!top.length) throw unreadable('empty moov');

  // mvhd — the presentation clock
  let duration_s = null;
  const mvhd = child(moov, top, 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.a];
    const timescale = v === 1 ? moov.readUInt32BE(mvhd.a + 20) : moov.readUInt32BE(mvhd.a + 12);
    const dur = v === 1 ? u64(moov, mvhd.a + 24) : moov.readUInt32BE(mvhd.a + 16);
    if (timescale > 0 && dur > 0) duration_s = Math.round((dur / timescale) * 100) / 100;
  }

  let video = null;
  let audio = false;
  for (const trak of top.filter((t) => t.type === 'trak')) {
    const tks = children(moov, trak.a, trak.b);
    const mdia = child(moov, tks, 'mdia');
    if (!mdia) continue;
    const mds = children(moov, mdia.a, mdia.b);
    const hdlr = child(moov, mds, 'hdlr');
    const handler = hdlr ? ascii(moov, hdlr.a + 8, hdlr.a + 12) : '';
    if (handler === 'soun') { audio = true; continue; }
    if (handler !== 'vide' || video) continue;

    const v = { w: null, h: null, codec_tag: null, fps: null };
    // tkhd — fixed-point 16.16 track pixels (fallback when stsd is odd)
    const tkhd = child(moov, tks, 'tkhd');
    if (tkhd) {
      const ver = moov[tkhd.a];
      const off = ver === 1 ? 88 : 76;
      if (tkhd.a + off + 8 <= tkhd.b) {
        v.w = moov.readUInt32BE(tkhd.a + off) >>> 16;
        v.h = moov.readUInt32BE(tkhd.a + off + 4) >>> 16;
      }
    }
    let mdhdTimescale = 0;
    const mdhd = child(moov, mds, 'mdhd');
    if (mdhd) {
      const ver = moov[mdhd.a];
      mdhdTimescale = ver === 1 ? moov.readUInt32BE(mdhd.a + 20) : moov.readUInt32BE(mdhd.a + 12);
    }
    const minf = child(moov, mds, 'minf');
    const stbl = minf ? child(moov, children(moov, minf.a, minf.b), 'stbl') : null;
    if (stbl) {
      const sts = children(moov, stbl.a, stbl.b);
      const stsd = child(moov, sts, 'stsd');
      if (stsd && moov.readUInt32BE(stsd.a + 4) >= 1) {
        const entry = stsd.a + 8;                    // first sample description
        v.codec_tag = ascii(moov, entry + 4, entry + 8).trim();
        // VisualSampleEntry: 6 reserved + 2 dref index + 16 predefined, then WxH
        const ew = moov.readUInt16BE(entry + 32);
        const eh = moov.readUInt16BE(entry + 34);
        if (ew > 0 && eh > 0) { v.w = ew; v.h = eh; }
      }
      // fps only when the timing table is ONE entry — anything richer is a
      // real edit and a single number would be a lie
      const stts = child(moov, sts, 'stts');
      if (stts && moov.readUInt32BE(stts.a + 4) === 1 && mdhdTimescale > 0) {
        const delta = moov.readUInt32BE(stts.a + 12);
        if (delta > 0) v.fps = Math.round((mdhdTimescale / delta) * 100) / 100;
      }
    }
    if (v.w || v.codec_tag) video = v;
  }

  if (!video) throw unreadable('moov carries no video track this probe understands');
  return {
    kind: 'video', container,
    codec: (video.codec_tag && CODEC_NAMES[video.codec_tag]) || video.codec_tag || null,
    codec_tag: video.codec_tag || null,
    w: video.w || null, h: video.h || null,
    duration_s, fps: video.fps, audio
  };
}

module.exports = { probeSpecs, PROBE_MAX_BYTES, PROBE_MAX_REQUESTS, CODEC_NAMES };
