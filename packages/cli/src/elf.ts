/**
 * The GNU build ID of an ELF file — what a Dart AOT snapshot prints as `build_id: '…'` in an
 * obfuscated stack, and what its `--split-debug-info` symbol file carries too.
 */

const NT_GNU_BUILD_ID = 3;
const SHT_NOTE = 7;
const PT_NOTE = 4;

export interface ElfInfo {
  /** Lowercase hex, as Dart prints it. */
  buildId?: string;
  bits: 32 | 64;
  littleEndian: boolean;
  /** e_machine, as an architecture name where known. */
  arch?: string;
}

const MACHINES: Record<number, string> = { 3: 'x86', 40: 'arm', 62: 'x86_64', 183: 'arm64', 243: 'riscv64' };

export function isElf(data: Uint8Array): boolean {
  return data.length >= 16 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46;
}

/** Parse just enough of an ELF file to find its GNU build ID. Throws on a file that is not ELF. */
export function readElf(data: Uint8Array): ElfInfo {
  if (!isElf(data)) throw new Error('not an ELF file');
  const bits = data[4] === 2 ? 64 : 32;
  const littleEndian = data[5] !== 2;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (o: number) => view.getUint16(o, littleEndian);
  const u32 = (o: number) => view.getUint32(o, littleEndian);
  const addr = (o: number) => (bits === 64 ? Number(view.getBigUint64(o, littleEndian)) : u32(o));
  const info: ElfInfo = { bits, littleEndian, arch: MACHINES[u16(18)] };

  const notes = (offset: number, size: number): string | undefined => {
    let p = offset;
    const end = Math.min(offset + size, data.length);
    while (p + 12 <= end) {
      const nameSize = u32(p);
      const descSize = u32(p + 4);
      const type = u32(p + 8);
      const nameStart = p + 12;
      const descStart = nameStart + align4(nameSize);
      if (descStart + descSize > end) break;
      const name = String.fromCharCode(...data.subarray(nameStart, nameStart + Math.max(0, nameSize - 1)));
      if (name === 'GNU' && type === NT_GNU_BUILD_ID) return hex(data.subarray(descStart, descStart + descSize));
      p = descStart + align4(descSize);
    }
    return undefined;
  };

  // Section headers first (symbol files keep them), then program headers (stripped binaries).
  const shoff = addr(bits === 64 ? 0x28 : 0x20);
  const shentsize = u16(bits === 64 ? 0x3a : 0x2e);
  const shnum = u16(bits === 64 ? 0x3c : 0x30);
  for (let i = 0; i < shnum && shoff > 0; i++) {
    const h = shoff + i * shentsize;
    if (h + shentsize > data.length) break;
    if (u32(h + 4) !== SHT_NOTE) continue;
    const offset = addr(bits === 64 ? h + 0x18 : h + 0x10);
    const size = addr(bits === 64 ? h + 0x20 : h + 0x14);
    const id = notes(offset, size);
    if (id) return { ...info, buildId: id };
  }
  const phoff = addr(bits === 64 ? 0x20 : 0x1c);
  const phentsize = u16(bits === 64 ? 0x36 : 0x2a);
  const phnum = u16(bits === 64 ? 0x38 : 0x2c);
  for (let i = 0; i < phnum && phoff > 0; i++) {
    const h = phoff + i * phentsize;
    if (h + phentsize > data.length) break;
    if (u32(h) !== PT_NOTE) continue;
    const offset = addr(bits === 64 ? h + 0x08 : h + 0x04);
    const size = addr(bits === 64 ? h + 0x20 : h + 0x10);
    const id = notes(offset, size);
    if (id) return { ...info, buildId: id };
  }
  return info;
}

const align4 = (n: number) => (n + 3) & ~3;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
