/**
 * Readable names for a dSYM's Swift symbols, uploaded beside it (`kind: symbol-names`), so a
 * crash reads "Cart.total() -> Int", not "$s9CrashTest4CartV5totalSiyF". Decoded by Xcode's own
 * `swift-demangle` — exactly the toolchain that compiled the app — on the Mac that uploads the
 * dSYMs (an Xcode build phase or a macOS CI job). Elsewhere, or without Xcode, nothing is added.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Runs an Xcode tool with `input` on stdin; its stdout, or null when it isn't there or fails. */
export type XcodeTool = (tool: string, args: string[], input?: string) => string | null;

export const xcrun: XcodeTool = (tool, args, input) => {
  const result = spawnSync('xcrun', [tool, ...args], { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : null;
};

/**
 * Swift 4.2+ mangled names anywhere in a DWARF file: its symbol table and its debug strings. A
 * Release build inlines functions, which then exist only in the debug info (DW_AT_linkage_name)
 * — what llvm-symbolizer names an inlined frame by — so the symbol table alone is not enough.
 */
const SWIFT = /\$s[0-9A-Za-z_$]{3,}/g;

/** What swift-demangle calls data symbols (metadata, descriptors, records), not code. */
const NOT_CODE = /^(type metadata(?! accessor)|full type metadata|(nominal type|protocol|protocol conformance|associated (type|conformance)|method|property|module|extension|anonymous|reflection metadata|opaque type) descriptor|reflection metadata|protocol (requirements base|witness table)(?! accessor)|value witness table|field offset|enum case for|lazy cache variable|demangling cache variable|flag for loading|metaclass for|class metadata base offset|objc metaclass|type metadata (pattern|completion|instantiation cache)|generic (type|protocol witness table) (instantiation cache|pattern))/;

/** The mangled Swift names in a DWARF file (read as bytes; no tools needed). */
export function mangledNamesIn(data: Buffer): Set<string> {
  return new Set(data.toString('latin1').match(SWIFT) ?? []);
}

/**
 * Mangled → readable for the Swift symbols in these DWARF files. Null when the tools aren't
 * there (not a Mac, no Xcode); empty when the files have no Swift.
 */
export function swiftNames(
  files: string[],
  tool: XcodeTool | null = process.platform === 'darwin' ? xcrun : null,
  read: (file: string) => Buffer = readFileSync,
): Record<string, string> | null {
  if (!tool) return null;
  const symbols = new Set<string>();
  for (const file of new Set(files)) {
    for (const name of mangledNamesIn(read(file))) symbols.add(name);
  }
  if (!symbols.size) return {};
  const mangled = [...symbols];
  const decoded = tool('swift-demangle', ['--simplified', '--compact'], `${mangled.join('\n')}\n`);
  if (decoded === null) return null;
  const lines = decoded.split('\n');
  const out: Record<string, string> = {};
  mangled.forEach((name, i) => {
    const readable = lines[i]?.trim();
    // Descriptors and metadata records are data, never a frame: left out, the map is smaller.
    if (readable && readable !== name && !NOT_CODE.test(readable)) out[name] = readable;
  });
  return out;
}
