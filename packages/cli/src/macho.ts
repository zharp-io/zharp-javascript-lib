/**
 * The LC_UUID of each architecture in a Mach-O file (thin or universal) — the UUID an iOS crash
 * report lists for each binary image, and the key its dSYM is found by.
 */

const LC_UUID = 0x1b;

export interface MachOImage {
  /** Uppercase with dashes, as the iOS SDK (`UUID.uuidString`) and Apple's tools print it. */
  uuid: string;
  arch: string;
  /** Where the image is in the file: the whole file, or its slice of a universal one. */
  offset: number;
  size: number;
}

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

export function isMachO(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const be = view.getUint32(0, false);
  const le = view.getUint32(0, true);
  return be === FAT_MAGIC || be === FAT_MAGIC_64 || [MH_MAGIC, MH_MAGIC_64].includes(le) || [MH_MAGIC, MH_MAGIC_64].includes(be);
}

export function archName(cpuType: number, cpuSubtype: number): string {
  const sub = cpuSubtype & 0x00ffffff;
  switch (cpuType) {
    case 0x0100000c:
      return sub === 2 ? 'arm64e' : 'arm64';
    case 0x0200000c:
      return 'arm64_32';
    case 0x0000000c:
      return sub === 9 ? 'armv7' : sub === 11 ? 'armv7s' : sub === 12 ? 'armv7k' : 'arm';
    case 0x01000007:
      return sub === 8 ? 'x86_64h' : 'x86_64';
    case 0x00000007:
      return 'i386';
    default:
      return `cpu${cpuType}`;
  }
}

/** The images in a Mach-O file: one for a thin file, one per slice for a universal one. */
export function readMachO(data: Uint8Array): MachOImage[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, false);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const wide = magic === FAT_MAGIC_64;
    const count = view.getUint32(4, false);
    const images: MachOImage[] = [];
    for (let i = 0; i < count; i++) {
      const h = 8 + i * (wide ? 32 : 20);
      const offset = wide ? Number(view.getBigUint64(h + 8, false)) : view.getUint32(h + 8, false);
      const size = wide ? Number(view.getBigUint64(h + 16, false)) : view.getUint32(h + 12, false);
      images.push(...readThin(data.subarray(offset, offset + size)).map((image) => ({ ...image, offset })));
    }
    return images;
  }
  return readThin(data);
}

function readThin(data: Uint8Array): MachOImage[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let little: boolean;
  if ([MH_MAGIC, MH_MAGIC_64].includes(view.getUint32(0, true))) little = true;
  else if ([MH_MAGIC, MH_MAGIC_64].includes(view.getUint32(0, false))) little = false;
  else throw new Error('not a Mach-O file');
  const wide = view.getUint32(0, little) === MH_MAGIC_64;
  const cpuType = view.getUint32(4, little);
  const cpuSubtype = view.getUint32(8, little);
  const ncmds = view.getUint32(16, little);
  let p = wide ? 32 : 28;
  for (let i = 0; i < ncmds && p + 8 <= data.length; i++) {
    const cmd = view.getUint32(p, little);
    const size = view.getUint32(p + 4, little);
    if (cmd === LC_UUID && p + 24 <= data.length) {
      return [{ uuid: formatUuid(data.subarray(p + 8, p + 24)), arch: archName(cpuType, cpuSubtype), offset: 0, size: data.length }];
    }
    if (size < 8) break;
    p += size;
  }
  return [];
}

function formatUuid(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  hex = hex.toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
