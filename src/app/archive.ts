/**
 * Small archive writers, so an export can be one file holding everything a
 * program needs: a ZIP (stored, no compression) and a gzipped TAR, which is
 * what a .unitypackage is.
 */
export interface ArchiveFile {
  path: string;
  data: Uint8Array;
}

const encoder = new TextEncoder();
export const textFile = (path: string, content: string): ArchiveFile => ({ path, data: encoder.encode(content) });

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A ZIP file with the given entries, uncompressed. */
export function zip(files: ArchiveFile[], when = new Date()): Uint8Array {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = encoder.encode(f.path);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, f.data.length, true);
    dir.setUint32(24, f.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  let dirSize = 0;
  for (const c of central) dirSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

/** A TAR archive (ustar) with the given entries. */
export function tar(files: ArchiveFile[], when = new Date()): Uint8Array {
  const parts: Uint8Array[] = [];
  const put = (block: Uint8Array, at: number, value: string) => block.set(encoder.encode(value), at);
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';
  for (const f of files) {
    const head = new Uint8Array(512);
    put(head, 0, f.path);
    put(head, 100, octal(0o644, 8));
    put(head, 108, octal(0, 8));
    put(head, 116, octal(0, 8));
    put(head, 124, octal(f.data.length, 12));
    put(head, 136, octal(Math.floor(when.getTime() / 1000), 12));
    put(head, 148, '        '); // checksum counts as spaces while it is being worked out
    put(head, 156, '0');
    put(head, 257, 'ustar\0');
    put(head, 263, '00');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += head[i];
    put(head, 148, sum.toString(8).padStart(6, '0') + '\0 ');
    parts.push(head, f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Thirty-two hex digits that are always the same for the same text (used as Unity asset ids). */
export function stableId(text: string): string {
  let out = '';
  for (let k = 0; k < 4; k++) {
    let hash = (0x811c9dc5 ^ (k * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out;
}
