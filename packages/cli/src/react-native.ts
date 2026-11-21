/**
 * `zharp react-native upload`: a React Native release build's source map, filed under the debug
 * ID @zharp/react-native/metro gave the bundle, so its errors read as the app's own source.
 *
 * The bundle is Hermes bytecode (or plain JS on JSC); either way it holds the marker string
 * `zharp-debug-id:<uuid>` the serializer wrote. The map is the composed one (Metro's mapped
 * through Hermes', as React Native's build writes it), with the sources inside.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { uploadArtifact, type Artifact, type Connection } from './api';
import { formatBytes } from './files';
import { consoleLogger, type Logger } from './log';

const MARKER = /zharp-debug-id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** The debug ID a bundle was built with, or null when it was built without the Zharp serializer. */
export function bundleDebugId(bundle: Buffer): string | null {
  return MARKER.exec(bundle.toString('latin1'))?.[1] ?? null;
}

export interface ReactNativeUploadOptions {
  release?: string;
  dryRun?: boolean;
  logger?: Logger;
  fetch?: typeof fetch;
}

export async function uploadReactNative(bundlePath: string, mapPath: string, connection: Connection | null, options: ReactNativeUploadOptions = {}): Promise<Artifact | null> {
  const logger = options.logger ?? consoleLogger();
  const id = bundleDebugId(readFileSync(bundlePath));
  if (!id) {
    throw new Error(`${bundlePath} has no Zharp debug ID — add withZharpConfig from @zharp/react-native/metro to metro.config.js, then build again.`);
  }
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  map.debugId = id;
  const withSources = Array.isArray(map.sourcesContent) ? map.sourcesContent.filter(Boolean).length : 0;
  const data = Buffer.from(JSON.stringify(map), 'utf8');
  // Keyed by the file name frames name it by: "index.android.bundle", "main.jsbundle".
  const artifact: Artifact = { kind: 'sourcemap', debugId: id, name: basename(bundlePath), release: options.release, data, gzip: true };
  if (!options.dryRun) {
    if (!connection) throw new Error('No connection to upload to.');
    await uploadArtifact(connection, artifact, { fetch: options.fetch });
  }
  logger.info(`${options.dryRun ? 'Would upload' : 'Uploaded'} the source map of ${basename(bundlePath)} (${formatBytes(data.length)}, ${withSources} source file(s) inside)  ${id}`);
  return artifact;
}
