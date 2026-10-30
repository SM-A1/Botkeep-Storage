// Minimal streaming ZIP writer: "stored" entries (no compression), data descriptors, UTF-8 names.
// Nothing is buffered beyond one chunk, so a collection can be streamed to the browser without touching disk.
// Not ZIP64: callers must keep the total below 4 GiB (config.collections.zipMaxBytes is capped at 3.5 GB).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc, buf) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getUTCFullYear());
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/** Safe, unique entry names: no paths, no control characters, duplicates get " (2)", " (3)" ... */
export function makeNameAllocator() {
  const used = new Set();
  return (raw) => {
    let name = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
    if (!name) name = 'file';
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let i = 2; used.has(candidate.toLowerCase()); i += 1) candidate = `${stem} (${i})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

/**
 * items: [{ name, modified?, open: async () => AsyncIterable<Buffer> }]
 * Yields Buffers forming a valid ZIP archive. An item whose open() or stream fails is skipped
 * (its partial bytes are never emitted unless the failure happens mid-stream, in which case the
 * archive is aborted by rethrowing so the client sees a failed download instead of a corrupt file).
 * Returns (via the generator's return value) the list of skipped names.
 */
export async function* zipStream(items, { notes = [] } = {}) {
  const central = [];
  const skipped = [];
  let offset = 0;

  const all = [...items];
  if (notes.length) {
    const body = Buffer.from(`${notes.join('\r\n')}\r\n`, 'utf8');
    all.push({ name: '_README.txt', modified: Date.now(), open: async () => [body] });
  }

  for (const item of all) {
    let source;
    try {
      source = await item.open();
    } catch {
      skipped.push(item.name);
      continue;
    }
    const nameBuf = Buffer.from(item.name, 'utf8');
    const { time, date } = dosDateTime(item.modified ?? Date.now());
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // bit 3: sizes follow in a data descriptor; bit 11: UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const headerOffset = offset;
    yield local;
    offset += local.length;

    let crc = 0;
    let size = 0;
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crc32Update(crc, buf);
      size += buf.length;
      offset += buf.length;
      yield buf;
    }
    if (size > 0xfffffffe || offset > 0xfffffffe) throw new Error('zip too large for the non-ZIP64 writer');

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    yield desc;
    offset += desc.length;
    central.push({ nameBuf, time, date, crc, size, headerOffset });
  }

  const cdStart = offset;
  for (const e of central) {
    const h = Buffer.alloc(46 + e.nameBuf.length);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0808, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(e.time, 12);
    h.writeUInt16LE(e.date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.size, 20);
    h.writeUInt32LE(e.size, 24);
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt32LE(e.headerOffset, 42);
    e.nameBuf.copy(h, 46);
    yield h;
    offset += h.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  yield end;
  return skipped;
}
