// UO Architect web client - loader.
// This page ships with NO Ultima Online art. The first time, the user points it at their own UO folder; the art library is
// built right here in the browser from those files and kept in this browser's IndexedDB. Saved designs only hold item IDs.
// (A port of launcher/ArtBuilder.cs + Uop.cs.)
(() => {
  'use strict';

  const CACHE_VERSION = 1;
  const DB_NAME = 'uo-architect-art', STORE = 'kv';
  const LAND_COUNT = 0x4000, STATIC_OFFSET = 0x4000, STATIC_COUNT = 0x10000;
  const REQUIRED = ['artLegacyMUL.uop', 'tiledata.mul', 'hues.mul', 'floors.txt', 'walls.txt', 'stairs.txt', 'doors.txt', 'misc.txt', 'roof.txt'];

  // ------------------------------------------------------------------ IndexedDB (cache + remembered folder handle)
  let dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbPromise;
  }
  async function idbGet(key) {
    const d = await db();
    return new Promise((res, rej) => { const r = d.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function idbSet(key, value) {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(value, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
  async function idbClear() {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).clear(); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  }

  // ------------------------------------------------------------------ file sources: {get(name) -> File/Blob | null}
  async function sourceFromDirHandle(handle) {
    const map = new Map();
    for await (const [name, h] of handle.entries()) if (h.kind === 'file') map.set(name.toLowerCase(), h);
    return { get: async (name) => { const h = map.get(name.toLowerCase()); return h ? h.getFile() : null; } };
  }
  function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];
      (function next() { reader.readEntries((es) => { if (!es.length) resolve(all); else { all.push(...es); next(); } }, reject); })();
    });
  }
  // root: a FileSystemDirectoryEntry from a drag and drop. Looks in the folder itself, then in Music/Digital.
  async function sourceFromDropEntry(root) {
    const top = new Map();
    for (const e of await readAllEntries(root.createReader())) top.set(e.name.toLowerCase(), e);
    let music = null;
    const m = top.get('music');
    if (m && m.isDirectory) {
      const d = (await readAllEntries(m.createReader())).find((e) => e.isDirectory && e.name.toLowerCase() === 'digital');
      if (d) { music = new Map(); for (const e of await readAllEntries(d.createReader())) if (e.isFile) music.set(e.name.toLowerCase(), e); }
    }
    const file = (e) => new Promise((res, rej) => e.file(res, rej));
    return { get: async (name) => {
      const k = name.toLowerCase(), e = top.get(k);
      if (e && e.isFile) return file(e);
      const me = music && music.get(k);
      return me ? file(me) : null;
    } };
  }
  function sourceFromFileList(files) {
    const map = new Map();
    for (const f of files) {
      const parts = (f.webkitRelativePath || f.name).split('/');
      const key = parts[parts.length - 1].toLowerCase();
      if (!map.has(key) || parts.length < map.get(key).depth) map.set(key, { file: f, depth: parts.length });
    }
    return { get: async (name) => { const e = map.get(name.toLowerCase()); return e ? e.file : null; } };
  }

  // ------------------------------------------------------------------ UOP archives
  const rot = (v, s) => ((v << s) | (v >>> (32 - s))) >>> 0;
  const hex8 = (n) => n.toString(16).padStart(8, '0');

  // UO's filename hash (Bob Jenkins' lookup3 hashlittle2); returned as "hhhhhhhhllllllll" so it can key a Map.
  function uopHash(name) {
    const d = new TextEncoder().encode(name.toLowerCase());
    let rem = d.length, pos = 0;
    let a = (rem + 0xDEADBEEF) >>> 0, b = a, c = a;
    const w = (o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
    while (rem > 12) {
      a = (a + w(pos)) >>> 0; b = (b + w(pos + 4)) >>> 0; c = (c + w(pos + 8)) >>> 0;
      a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
      b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
      c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
      a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
      b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
      c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
      pos += 12; rem -= 12;
    }
    if (rem >= 12) c = (c + (d[pos + 11] << 24)) >>> 0;
    if (rem >= 11) c = (c + (d[pos + 10] << 16)) >>> 0;
    if (rem >= 10) c = (c + (d[pos + 9] << 8)) >>> 0;
    if (rem >= 9) c = (c + d[pos + 8]) >>> 0;
    if (rem >= 8) b = (b + (d[pos + 7] << 24)) >>> 0;
    if (rem >= 7) b = (b + (d[pos + 6] << 16)) >>> 0;
    if (rem >= 6) b = (b + (d[pos + 5] << 8)) >>> 0;
    if (rem >= 5) b = (b + d[pos + 4]) >>> 0;
    if (rem >= 4) a = (a + (d[pos + 3] << 24)) >>> 0;
    if (rem >= 3) a = (a + (d[pos + 2] << 16)) >>> 0;
    if (rem >= 2) a = (a + (d[pos + 1] << 8)) >>> 0;
    if (rem >= 1) a = (a + d[pos]) >>> 0;
    if (rem === 0) return hex8(c) + hex8(0);
    c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
    return hex8(b) + hex8(c);
  }
  const artName = (index) => 'build/artlegacymul/' + String(index).padStart(8, '0') + '.tga';

  // Finds the payload location of every wanted name hash.
  async function uopIndex(file, wanted) {
    const found = new Map();
    const size = file.size;
    const head = new DataView(await file.slice(0, 28).arrayBuffer());
    if (head.byteLength < 28 || head.getUint32(0, true) !== 0x0050594D) throw new Error(file.name + ' is not a valid UOP archive.');
    let block = Number(head.getBigUint64(12, true));
    const seen = new Set();
    while (block !== 0) {
      if (seen.has(block) || block + 12 > size) throw new Error('Invalid UOP block chain.');
      seen.add(block);
      const bh = new DataView(await file.slice(block, block + 12).arrayBuffer());
      const count = bh.getUint32(0, true), next = Number(bh.getBigUint64(4, true));
      if (count > 100000 || block + 12 + count * 34 > size) throw new Error('Invalid UOP block size.');
      const ev = new DataView(await file.slice(block + 12, block + 12 + count * 34).arrayBuffer());
      for (let i = 0; i < count; i++) {
        const o = i * 34;
        const offset = Number(ev.getBigUint64(o, true));
        const headerLen = ev.getUint32(o + 8, true), packed = ev.getUint32(o + 12, true), raw = ev.getUint32(o + 16, true);
        const key = hex8(ev.getUint32(o + 24, true)) + hex8(ev.getUint32(o + 20, true));
        const compression = ev.getUint16(o + 32, true);
        if (offset !== 0 && wanted.has(key)) found.set(key, { offset: offset + headerLen, packed, raw, compression });
      }
      block = next;
    }
    return found;
  }

  async function inflate(buf) {                       // zlib stream
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Reads (and inflates) one payload; null if it cannot be read.
  async function uopRead(file, e) {
    if (e.offset + e.packed > file.size) return null;
    const buf = new Uint8Array(await file.slice(e.offset, e.offset + e.packed).arrayBuffer());
    if (buf.length !== e.packed) return null;
    if (e.compression === 0) return (e.raw === 0 || buf.length === e.raw) ? buf : null;
    if (e.compression !== 1) return null;
    try { const out = await inflate(buf); return (e.raw === 0 || out.length === e.raw) ? out : null; } catch (err) { return null; }
  }

  // ------------------------------------------------------------------ tiledata
  function ascii(d, off, len) {
    let n = 0;
    while (n < len && d[off + n] !== 0) n++;
    let s = '';
    for (let i = 0; i < n; i++) s += d[off + i] < 128 ? String.fromCharCode(d[off + i]) : '�';
    return s.trim();
  }
  const u64 = (dv, o) => dv.getUint32(o + 4, true) * 4294967296 + dv.getUint32(o, true);   // one rounding, same as parsing the decimal text

  function readTiledata(raw) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const landGroup = 4 + 32 * 30, staticStart = 512 * landGroup, staticGroup = 4 + 32 * 41;
    if (raw.length < staticStart || (raw.length - staticStart) % staticGroup !== 0) throw new Error('tiledata.mul is not the expected 64-bit layout.');
    const land = [], statics = [];
    for (let id = 0; id < LAND_COUNT; id++) {
      const o = Math.floor(id / 32) * landGroup + 4 + (id % 32) * 30;
      const name = ascii(raw, o + 10, 20);
      if (!name) continue;
      land.push({ id, name, type: 'land', flags: u64(dv, o), texture: dv.getUint16(o + 8, true) });
    }
    const staticLength = (raw.length - staticStart) / staticGroup * 32;
    for (let id = 0; id < staticLength; id++) {
      const o = staticStart + Math.floor(id / 32) * staticGroup + 4 + (id % 32) * 41;
      const name = ascii(raw, o + 21, 20);
      if (!name) continue;
      statics.push({ id, name, type: 'static', flags: u64(dv, o) });
    }
    return { land, statics, staticStart, staticGroup, staticLength, dv };
  }

  // ------------------------------------------------------------------ floors / walls / stairs ... tables
  function readTable(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const rows = [];
    if (lines.length < 3) return rows;
    const headers = lines[1].split('\t');
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let values = line.split('\t');
      if (values.length < headers.length) values = line.split(/\s+/).filter(Boolean);
      while (values.length < headers.length) values.push('');
      const row = {};
      for (let h = 0; h < headers.length; h++) row[headers[h]] = values[h];
      rows.push(row);
    }
    return rows;
  }
  function positiveId(value) {
    const v = String(value || '').trim();
    let n;
    if (/^0x/i.test(v)) { if (!/^0x[0-9a-f]+$/i.test(v)) return -1; n = parseInt(v.slice(2), 16); }
    else if (/^[+-]?\d+$/.test(v)) n = parseInt(v, 10);
    else return -1;
    return (n > 0 && n < STATIC_COUNT) ? n : -1;
  }
  const numbered = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + (i + 1));

  const TABLE_SPECS = [
    { file: 'floors.txt', category: 'floors', columns: numbered('F', 16) },
    { file: 'walls.txt', category: 'walls', columns: ['South1', 'South2', 'South3', 'Corner', 'East1', 'East2', 'East3', 'Post', 'WindowS', 'AltWindowS', 'WindowE', 'AltWindowE', 'SecondAltWindowS', 'SecondAltWindowE'] },
    { file: 'stairs.txt', category: 'parts', columns: ['Block', 'North', 'East', 'South', 'West', 'Squared1', 'Squared2', 'Rounded1', 'Rounded2', 'MultiNorth', 'MultiEast', 'MultiSouth', 'MultiWest'] },
    { file: 'doors.txt', category: 'parts', columns: numbered('Piece', 8) },
    { file: 'misc.txt', category: 'parts', columns: numbered('Piece', 8) },
    { file: 'roof.txt', category: 'parts', columns: ['North', 'East', 'South', 'West', 'NSCrosspiece', 'EWCrosspiece', 'NDent', 'EDent', 'SDent', 'WDent', 'NTPiece', 'ETPiece', 'STPiece', 'WTPiece', 'XPiece', 'Extra Piece'] },
  ];

  async function readBuildingTables(source, tables, buildIds) {
    const seen = { floors: new Map(), walls: new Map(), parts: new Map() };
    for (const c of ['floors', 'walls', 'parts']) tables[c] = [];
    for (const spec of TABLE_SPECS) {
      const f = await source.get(spec.file);
      const text = new TextDecoder('utf-8').decode(await f.arrayBuffer());
      const base = spec.file.slice(0, -4);
      const titled = base.charAt(0).toUpperCase() + base.slice(1);
      for (const row of readTable(text)) {
        let comment = (row.Comment || '').trim();
        if (!comment) comment = titled;
        for (const column of spec.columns) {
          const id = positiveId(row[column]);
          if (id < 0) continue;
          const label = comment + ' · ' + column;
          const existing = seen[spec.category].get(id);
          if (existing) { if (!existing.aliases.includes(label)) existing.aliases.push(label); continue; }
          const t = { id, name: label, type: 'static', group: spec.category, part: column, aliases: [] };
          seen[spec.category].set(id, t);
          tables[spec.category].push(t);
          buildIds.add(id);
        }
      }
    }
  }

  // ------------------------------------------------------------------ sprite decoding
  const u16 = (p, o) => p[o] | (p[o + 1] << 8);

  function decodeStatic(p) {
    if (p.length < 8) return null;
    const w = u16(p, 4), h = u16(p, 6);
    if (!(w > 0 && w <= 2048 && h > 0 && h <= 2048)) return null;
    const tableStart = h + 4, tableEnd = (tableStart + h) * 2;
    if (tableEnd > p.length) return null;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      let pos = (tableStart + u16(p, (4 + y) * 2)) * 2, x = 0;
      for (;;) {
        if (pos + 4 > p.length) return null;
        const skip = u16(p, pos), run = u16(p, pos + 2);
        pos += 4;
        if (skip === 0 && run === 0) break;
        x += skip;
        if (x + run > w || pos + run * 2 > p.length) return null;
        for (let r = 0; r < run; r++) {
          const color = u16(p, pos) ^ 0x8000;
          pos += 2;
          const red = (color >> 10) & 0x1F, green = (color >> 5) & 0x1F, blue = color & 0x1F;
          const o = (y * w + x) * 4;
          rgba[o] = (red << 3) | (red >> 2); rgba[o + 1] = (green << 3) | (green >> 2); rgba[o + 2] = (blue << 3) | (blue >> 2);
          rgba[o + 3] = (color & 0x8000) ? 255 : 0;
          x++;
        }
      }
    }
    return { w, h, rgba };
  }

  function decodeLand(p) {
    if (p.length < 2024) return null;
    const rgba = new Uint8ClampedArray(44 * 44 * 4);
    let src = 0;
    for (let y = 0; y < 44; y++) {
      let start, length;
      if (y < 22) { start = 21 - y; length = y * 2 + 2; } else { const row = y - 22; start = row; length = 44 - row * 2; }
      for (let x = start; x < start + length; x++) {
        const color = u16(p, src); src += 2;
        const red = (color >> 10) & 0x1F, green = (color >> 5) & 0x1F, blue = color & 0x1F;
        const o = (y * 44 + x) * 4;
        rgba[o] = (red << 3) | (red >> 2); rgba[o + 1] = (green << 3) | (green >> 2); rgba[o + 2] = (blue << 3) | (blue >> 2); rgba[o + 3] = 255;
      }
    }
    return { w: 44, h: 44, rgba };
  }

  // Coarse solid-pixel map (8px cells) used to tell which placed piece is under the mouse.
  function mask8(rgba, w, h) {
    const cols = (w + 7) >> 3, rows = (h + 7) >> 3;
    const bytes = new Uint8Array((cols * rows + 7) >> 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (rgba[(y * w + x) * 4 + 3] > 10) { const i = (y >> 3) * cols + (x >> 3); bytes[i >> 3] |= 0x80 >> (i & 7); }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  // ------------------------------------------------------------------ atlas pages (1024x1024, 1px gutter)
  const ATLAS = 1024;
  class Atlas {
    constructor(kind) { this.kind = kind; this.page = 0; this.x = 1; this.y = 1; this.rowH = 0; this.px = new Uint8ClampedArray(ATLAS * ATLAS * 4); this.files = []; this.full = []; }
    add(w, h, rgba) {
      if (w + 2 > ATLAS || h + 2 > ATLAS) throw new Error('sprite too large');
      if (this.x + w + 1 > ATLAS) { this.x = 1; this.y += this.rowH + 1; this.rowH = 0; }
      if (this.y + h + 1 > ATLAS) this.flush();
      const sx = this.x, sy = this.y;
      for (let r = 0; r < h; r++) this.px.set(rgba.subarray(r * w * 4, (r + 1) * w * 4), ((sy + r) * ATLAS + sx) * 4);
      this.x += w + 1;
      if (h > this.rowH) this.rowH = h;
      return { sheet: this.page, x: sx, y: sy, w, h };
    }
    flush() {
      if (this.x === 1 && this.y === 1 && this.rowH === 0) return;
      const file = this.kind + '-' + String(this.page).padStart(3, '0') + '.png';
      this.full.push({ file, px: this.px });
      this.files.push(file);
      this.page++; this.x = 1; this.y = 1; this.rowH = 0;
      this.px = new Uint8ClampedArray(ATLAS * ATLAS * 4);
    }
    // encodes the finished pages to PNG blobs (kept out of add() because encoding is asynchronous)
    async drain(sheets) {
      while (this.full.length) {
        const { file, px } = this.full.shift();
        const canvas = new OffscreenCanvas(ATLAS, ATLAS);
        canvas.getContext('2d').putImageData(new ImageData(px, ATLAS, ATLAS), 0, 0);
        sheets[file] = await canvas.convertToBlob({ type: 'image/png' });
      }
    }
  }

  // ------------------------------------------------------------------ hues and heights
  function buildHues(d) {
    const entry = 88, group = 4 + 8 * 88;
    if (d.length % group !== 0) throw new Error('hues.mul has an unexpected size.');
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const ids = [], names = [], ramps = [];
    let total = 0;
    for (let g = 0; g < d.length / group; g++) {
      for (let i = 0; i < 8; i++) {
        total++;
        const e = g * group + 4 + i * entry;
        let flat = true;
        const first = dv.getUint16(e, true);
        for (let c = 1; c < 32; c++) if (dv.getUint16(e + c * 2, true) !== first) { flat = false; break; }
        if (flat) continue;
        ids.push(total);
        names.push(ascii(d, e + 68, 20));
        ramps.push(d.subarray(e, e + 64));
      }
    }
    const all = new Uint8Array(ramps.length * 64);
    ramps.forEach((r, i) => all.set(r, i * 64));
    let s = '';
    for (let i = 0; i < all.length; i += 8192) s += String.fromCharCode.apply(null, all.subarray(i, i + 8192));
    return { ids, names, c: btoa(s) };
  }

  function buildHeights(raw, td) {
    const out = {};
    for (let id = 0; id < td.staticLength; id++) {
      const o = td.staticStart + Math.floor(id / 32) * td.staticGroup + 4 + (id % 32) * 41;
      let height = raw[o + 20];
      if (td.dv.getUint32(o, true) & 0x400) height = Math.trunc(height / 2);   // bridge items count half, as the client does
      if (height === 0) continue;
      out[id] = height;
    }
    return out;
  }

  // ------------------------------------------------------------------ the whole build
  async function missingFiles(source) {
    const missing = [];
    for (const f of REQUIRED) if (!(await source.get(f))) missing.push(f);
    return missing;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function build(source, progress) {
    progress = progress || (() => {});
    const missing = await missingFiles(source);
    if (missing.length) throw new Error('That folder is missing: ' + missing.join(', ') + '. Pick the folder your Ultima Online client is installed in.');

    progress(1, 'Reading item names and building parts...');
    const tdRaw = new Uint8Array(await (await source.get('tiledata.mul')).arrayBuffer());
    const td = readTiledata(tdRaw);
    const tables = {};
    const buildIds = new Set();
    await readBuildingTables(source, tables, buildIds);
    const named = new Map();
    for (const t of td.statics) named.set(t.id, t);
    for (const cat of ['floors', 'walls', 'parts'])
      for (const t of tables[cat]) { const item = named.get(t.id); if (item) { t.tileName = item.name; t.flags = item.flags; } }
    tables.items = td.statics.filter((t) => !buildIds.has(t.id));
    tables.terrain = td.land;

    const staticIds = new Set(named.keys());
    for (const id of buildIds) staticIds.add(id);
    const sortedStatic = Array.from(staticIds).sort((a, b) => a - b);

    progress(4, 'Indexing your art archive...');
    const wanted = new Map(), order = [];
    for (const id of sortedStatic) { const h = uopHash(artName(id + STATIC_OFFSET)); if (!wanted.has(h)) { wanted.set(h, ['static', id]); order.push(h); } }
    for (const t of td.land) { const h = uopHash(artName(t.id)); if (!wanted.has(h)) { wanted.set(h, ['land', t.id]); order.push(h); } }
    const archive = await source.get('artLegacyMUL.uop');
    const records = await uopIndex(archive, new Set(wanted.keys()));

    const sheets = {};
    const staticAtlas = new Atlas('static'), landAtlas = new Atlas('land');
    const staticSprites = [], landSprites = [];
    const hasStatic = new Set(), hasLand = new Set(), masks = {};
    let done = 0;
    const total = order.length;
    for (const hash of order) {
      done++;
      if ((done & 255) === 0) {
        progress(6 + Math.floor(84 * done / total), 'Building your art library... ' + done.toLocaleString('en-US') + ' of ' + total.toLocaleString('en-US'));
        await staticAtlas.drain(sheets); await landAtlas.drain(sheets);
        await tick();
      }
      const e = records.get(hash);
      if (!e) continue;
      const payload = await uopRead(archive, e);
      if (!payload) continue;
      const [kind, id] = wanted.get(hash);
      const spr = kind === 'static' ? decodeStatic(payload) : decodeLand(payload);
      if (!spr) continue;
      if (kind === 'static') {
        staticSprites.push([id, staticAtlas.add(spr.w, spr.h, spr.rgba)]);
        hasStatic.add(id);
        masks[id] = mask8(spr.rgba, spr.w, spr.h);
      } else {
        landSprites.push([id, landAtlas.add(spr.w, spr.h, spr.rgba)]);
        hasLand.add(id);
      }
    }
    progress(91, 'Saving sprite sheets...');
    staticAtlas.flush(); landAtlas.flush();
    await staticAtlas.drain(sheets); await landAtlas.drain(sheets);

    const byId = (a, b) => a[0] - b[0];
    staticSprites.sort(byId); landSprites.sort(byId);

    progress(94, 'Writing the item catalog...');
    const entryOf = (t) => {
      const e = { id: t.id, name: t.name, type: t.type };
      if (t.group != null) {
        e.group = t.group; e.part = t.part; e.aliases = t.aliases;
        if (t.tileName != null) { e.tileName = t.tileName; e.flags = t.flags; }
      } else {
        e.flags = t.flags;
        if (t.texture != null && t.texture >= 0) e.texture = t.texture;
      }
      return e;
    };
    const categories = {}, counts = {};
    for (const cat of ['floors', 'walls', 'parts', 'items', 'terrain']) {
      categories[cat] = tables[cat].filter((t) => (t.type === 'static' ? hasStatic : hasLand).has(t.id)).map(entryOf);
      counts[cat] = categories[cat].length;
    }
    const spriteMap = (list) => { const o = {}; for (const [id, s] of list) o[id] = s; return o; };
    const catalog = {
      format: 'britannia-uo-catalog-v1', client: '1.25', categories,
      sprites: { static: spriteMap(staticSprites), land: spriteMap(landSprites) },
      sheets: { static: staticAtlas.files, land: landAtlas.files },
      summary: { static: staticSprites.length, land: landSprites.length, buildingParts: { floors: counts.floors, walls: counts.walls, parts: counts.parts } },
    };

    progress(97, 'Reading heights and colors...');
    const heights = buildHeights(tdRaw, td);
    const hues = buildHues(new Uint8Array(await (await source.get('hues.mul')).arrayBuffer()));
    progress(100, 'Done');
    return { catalog, hit: { cell: 8, m: masks }, heights, hues, sheets };
  }

  // ------------------------------------------------------------------ cache
  async function saveCache(result, extra) {
    await idbClear();
    const files = Object.keys(result.sheets);
    for (const f of files) await idbSet('sheet:' + f, result.sheets[f]);
    await idbSet('data', { catalog: result.catalog, hit: result.hit, heights: result.heights, hues: result.hues });
    await idbSet('meta', Object.assign({ version: CACHE_VERSION, builtAt: Date.now(), sheets: files }, extra || {}));
  }
  async function loadCache() {
    const meta = await idbGet('meta');
    if (!meta || meta.version !== CACHE_VERSION) return null;
    const data = await idbGet('data');
    if (!data) return null;
    const urls = {};
    for (const f of meta.sheets) {
      const blob = await idbGet('sheet:' + f);
      if (!blob) return null;
      urls[f] = URL.createObjectURL(blob);
    }
    return { data, urls, meta };
  }
  function install(data, urls) {
    window.UO_ASSET_CATALOG = data.catalog;
    window.UO_HIT = data.hit;
    window.UO_HEIGHT = data.heights;
    window.UO_HUES = data.hues;
    window.UO_SHEET_URL = (file) => urls[file];
  }

  // ------------------------------------------------------------------ the page
  // ------------------------------------------------------------------ music (read from the user's own Music/Digital folder when played)
  let musicSource = null;
  const why = [];                                          // why the folder had to be asked for again (shown to help diagnose)
  const MUSIC_FILES = ['Stones1.mp3', 'Britainpos.mp3', 'Tavern1.mp3', 'Honor.mp3', 'Walking.mp3', 'Cove.mp3', 'Newmagincia.mp3', 'Zento.mp3', 'Turfin.mp3'];   // keep in step with TRACKS in app.js
  // The few tracks in the menu are kept in this browser once they have been read, so later plays never ask for the folder.
  async function precacheMusic(src) {
    for (const name of MUSIC_FILES) {
      try {
        if (await idbGet('music:' + name)) continue;
        const f = await src.get(name);
        if (f) await idbSet('music:' + name, new Blob([await f.arrayBuffer()], { type: 'audio/mpeg' }));
      } catch (e) { /* skip this one */ }
    }
  }
  async function findDir(handle, name) {
    for await (const [n, h] of handle.entries()) if (h.kind === 'directory' && n.toLowerCase() === name.toLowerCase()) return h;
    return null;
  }
  async function musicSourceFromDir(root) {
    const music = await findDir(root, 'Music');
    const digital = music && await findDir(music, 'Digital');
    if (!digital) return null;
    const map = new Map();
    for await (const [n, h] of digital.entries()) if (h.kind === 'file') map.set(n.toLowerCase(), h);
    return { get: async (name) => { const h = map.get(name.toLowerCase()); return h ? h.getFile() : null; } };
  }
  // Must be called from a click (the browser may ask for folder access). Returns a File for the track, or throws a readable error.
  async function getMusicFile(name) {
    try { const cachedTrack = await idbGet('music:' + name); if (cachedTrack) return cachedTrack; } catch (e) { /* not cached yet */ }
    why.length = 0;
    if (!musicSource) {
      why.push('the music was not saved when the art was built');
      const files = await new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.webkitdirectory = true; inp.multiple = true;
        inp.onchange = () => resolve(Array.from(inp.files));
        inp.addEventListener('cancel', () => resolve([]));
        inp.click();
      });
      if (files.length) musicSource = sourceFromFileList(files);
      if (!musicSource || !(await musicSource.get(name))) { musicSource = null; throw new Error('Could not find the music. Select your Ultima Online Classic folder.'); }
    }
    await precacheMusic(musicSource);                    // remember the menu tracks so this question is only asked once
    try { const stored = await idbGet('music:' + name); if (stored) return stored; } catch (e) { /* use the file directly */ }
    const f = await musicSource.get(name);
    if (!f) throw new Error(name + ' is not in your UO Music folder.');
    return f;
  }

  window.UOLoader = { sourceFromDropEntry, musicWhy: () => why.join('; '), getMusicFile, build, uopHash, saveCache, loadCache, install, sourceFromFileList, sourceFromDirHandle, REQUIRED };

  function startApp() {
    const s = document.createElement('script');
    s.src = 'app.js?v=12';
    document.body.appendChild(s);
  }

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const k in (attrs || {})) { if (k === 'class') n.className = attrs[k]; else if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); }
    for (const kid of kids) n.append(kid);
    return n;
  }

  async function boot() {
    if (window.UO_TEST_MODE) return;                     // the test page drives the loader itself
    const overlay = document.getElementById('uo-setup');
    const status = document.getElementById('uo-status'), bar = document.getElementById('uo-bar'), err = document.getElementById('uo-error');
    const pick = document.getElementById('uo-pick'), fallback = document.getElementById('uo-folder-input'), again = document.getElementById('uo-change');
    const canRun = typeof DecompressionStream === 'function' && typeof OffscreenCanvas === 'function';
    let started = false;

    const show = () => { overlay.hidden = false; const g = document.getElementById('uo-gif'); if (g && !g.getAttribute('src')) g.src = g.dataset.src; };
    const hide = () => { overlay.hidden = true; };
    const fail = (m) => { err.textContent = m; err.hidden = false; status.textContent = ''; pick.disabled = false; };
    const progress = (pct, text) => { bar.style.width = pct + '%'; status.textContent = text; };

    async function run(source, handle) {
      pick.disabled = true; err.hidden = true; bar.parentElement.hidden = false;
      try {
        const result = await build(source, progress);
        status.textContent = 'Saving to this browser...';
        await saveCache(result, {});
        if (handle) { try { await idbSet('folder', handle); } catch (e) { /* handles cannot be stored in every browser */ } }
        status.textContent = 'Saving the game music...';
        try { const ms = handle ? await musicSourceFromDir(handle) : source; if (ms) await precacheMusic(ms); } catch (e) { /* music is optional */ }
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
        const cached = await loadCache();
        install(cached.data, cached.urls);
        hide();
        if (!started) { started = true; startApp(); } else location.reload();
      } catch (e) {
        console.error(e);
        fail(String(e && e.message || e));
        bar.parentElement.hidden = true;
      }
    }

    if (!canRun) { show(); pick.disabled = true; fail('This browser is too old for the art loader. Please use a current Chrome, Edge or Firefox on a computer.'); return; }

    pick.onclick = () => { fallback.click(); };
    fallback.onchange = () => { const files = Array.from(fallback.files); fallback.value = ''; if (files.length) run(sourceFromFileList(files), null); };
    document.getElementById('uo-copy').onclick = async () => {
      const b = document.getElementById('uo-copy');
      try { await navigator.clipboard.writeText(document.getElementById('uo-path').textContent); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select and copy it'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 2000);
    };
    again.onclick = () => { show(); document.getElementById('uo-intro').hidden = false; };

    let cached = null;
    try { cached = await loadCache(); } catch (e) { console.warn('cache unreadable', e); }
    if (cached) {
      install(cached.data, cached.urls);
      hide();
      started = true;
      startApp();
    } else {
      show();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
