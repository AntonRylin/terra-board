// Voice messages: Chromium records Opus in WebM, and Telegram plays voice
// messages as Opus in Ogg. This moves the same Opus packets from one container
// to the other, without decoding or re-encoding anything.

// An EBML variable-length number at `at`: its byte length and value (with
// the length marker kept for IDs, removed for sizes). null past the end.
function vint(bytes, at, keepMarker) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) unknown = false;
  }
  return { length, value, unknown: !keepMarker && unknown };
}

const SEGMENT = 0x18538067,
  CLUSTER = 0x1f43b675,
  TRACKS = 0x1654ae6b,
  TRACK_ENTRY = 0xae,
  BLOCK_GROUP = 0xa0,
  BLOCK = 0xa1,
  SIMPLE_BLOCK = 0xa3,
  CODEC_ID = 0x86,
  CODEC_PRIVATE = 0x63a2;
const containers = new Set([SEGMENT, CLUSTER, TRACKS, TRACK_ENTRY, BLOCK_GROUP]);

/** The Opus packets and Opus header of a WebM recording (first audio track). */
function readWebm(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const packets = [];
  let head = null,
    codec = '',
    track = 0,
    at = 0;
  while (at < bytes.length) {
    const id = vint(bytes, at, true);
    if (!id) break;
    const size = vint(bytes, at + id.length, false);
    if (!size) break;
    const start = at + id.length + size.length;
    // Containers (often of unknown size while recording) are read through.
    if (containers.has(id.value)) {
      at = start;
      continue;
    }
    const end = size.unknown ? bytes.length : start + size.value;
    if (end > bytes.length) break;
    if (id.value === CODEC_ID) codec = new TextDecoder().decode(bytes.subarray(start, end));
    else if (id.value === CODEC_PRIVATE && !head) head = bytes.slice(start, end);
    else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      const number = vint(bytes, start, false);
      const flags = bytes[start + number.length + 2];
      track ||= number.value;
      if (number.value === track) {
        if (flags & 0x06) throw Error('This recording uses a WebM layout Terra can’t read.');
        packets.push(bytes.slice(start + number.length + 3, end));
      }
    }
    at = end;
  }
  if (codec && codec !== 'A_OPUS') throw Error('The recording isn’t Opus audio.');
  if (!packets.length) throw Error('The recording is empty.');
  return { head, packets };
}

// Samples (at 48 kHz) in one Opus packet, from its table-of-contents byte.
function packetSamples(packet) {
  const toc = packet[0];
  const config = toc >> 3;
  const frame =
    config < 12
      ? [480, 960, 1920, 2880][config % 4]
      : config < 16
        ? [480, 960][config % 2]
        : [120, 240, 480, 960][config % 4];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? packet[1] & 0x3f : 2;
  return frame * frames;
}

// Ogg's CRC-32 (polynomial 0x04c11db7, not reflected).
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  table[i] = r >>> 0;
}
function crc(bytes) {
  let c = 0;
  for (const b of bytes) c = ((c << 8) ^ table[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}

function page(packets, { granule, serial, sequence, flags }) {
  const lacing = [];
  for (const p of packets) {
    let left = p.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const body = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0);
  out[5] = flags;
  view.setBigInt64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  view.setUint32(22, crc(out), true);
  return out;
}

/** An Ogg Opus file from a WebM Opus recording, and its length in seconds. */
function webmToOgg(input, { serial = 0x7e44a001 } = {}) {
  const { head: given, packets } = readWebm(input);
  let head = given;
  if (!head || new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') {
    head = new Uint8Array(19);
    head.set(new TextEncoder().encode('OpusHead'));
    const v = new DataView(head.buffer);
    head[8] = 1;
    head[9] = 1;
    v.setUint16(10, 312, true);
    v.setUint32(12, 48000, true);
  }
  const preSkip = new DataView(head.buffer, head.byteOffset).getUint16(10, true);
  const vendor = new TextEncoder().encode('Terra Board');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages = [
    page([head], { granule: 0, serial, sequence: 0, flags: 0x02 }),
    page([tags], { granule: 0, serial, sequence: 1, flags: 0 }),
  ];
  let granule = preSkip,
    group = [],
    segments = 0,
    total = 0;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const samples = packetSamples(p);
    granule += samples;
    total += samples;
    group.push(p);
    segments += Math.floor(p.length / 255) + 1;
    const last = i === packets.length - 1;
    if (last || segments > 200 || group.length >= 50) {
      pages.push(page(group, { granule, serial, sequence: pages.length, flags: last ? 0x04 : 0 }));
      group = [];
      segments = 0;
    }
  }
  const size = pages.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return { bytes: out, seconds: total / 48000 };
}

module.exports = { webmToOgg, readWebm, packetSamples, crc };
