/**
 * The artifact upload API: `POST /api/v1/applications/:id/artifacts`, multipart, with a
 * workspace API key that has the `artifacts:write` scope.
 */
import { gzipSync } from 'node:zlib';

export const DEFAULT_URL = 'https://api.zharp.io';

export type ArtifactKind = 'sourcemap' | 'minified-source' | 'proguard' | 'dart-symbols' | 'dart-obfuscation-map' | 'dsym' | 'source-bundle';

export interface Connection {
  /** The Zharp API's base URL, e.g. https://api.zharp.io. */
  url: string;
  /** A workspace API key with the `artifacts:write` scope. */
  authToken: string;
  /** The application's ID, as in the dashboard URL. */
  app: string | number;
}

export interface Artifact {
  kind: ArtifactKind;
  debugId: string;
  /** The file's path or URL (JS), or file name. */
  name: string;
  release?: string;
  arch?: string;
  data: Uint8Array;
  /** Send gzipped (large native symbol files). */
  gzip?: boolean;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Retrying will not help: a rejected key, a missing app, a bad request. */
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * The connection from options and the environment (`ZHARP_AUTH_TOKEN`, `ZHARP_URL`,
 * `ZHARP_APP`). Throws with what is missing.
 */
export function resolveConnection(options: { url?: string; authToken?: string; app?: string | number }): Connection {
  const authToken = options.authToken || process.env.ZHARP_AUTH_TOKEN;
  const app = options.app ?? process.env.ZHARP_APP;
  const missing: string[] = [];
  if (!authToken) missing.push('an auth token (ZHARP_AUTH_TOKEN, or the authToken option): a workspace API key with the "artifacts:write" scope');
  if (app === undefined || app === '') missing.push('the application ID (--app, the app option, or ZHARP_APP)');
  if (missing.length) throw new UploadError(`Cannot upload without ${missing.join(' and ')}.`, undefined, true);
  return { url: (options.url || process.env.ZHARP_URL || DEFAULT_URL).replace(/\/+$/, ''), authToken: authToken!, app: app! };
}

export function artifactsUrl(connection: Connection): string {
  return `${connection.url}/api/v1/applications/${encodeURIComponent(String(connection.app))}/artifacts`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Upload one artifact, retrying network failures, 408, 429 and 5xx with backoff. */
export async function uploadArtifact(
  connection: Connection,
  artifact: Artifact,
  options: { retries?: number; fetch?: typeof fetch; backoffMs?: number } = {},
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const retries = options.retries ?? 3;
  const backoff = options.backoffMs ?? 1000;
  const fileName = (artifact.name.split('/').pop() || 'artifact') + (artifact.gzip ? '.gz' : '');
  const payload = artifact.gzip ? gzipSync(artifact.data) : artifact.data;

  for (let attempt = 0; ; attempt++) {
    // A fresh body per attempt: a FormData is consumed by the request that sends it.
    const form = new FormData();
    form.set('kind', artifact.kind);
    form.set('debugId', artifact.debugId);
    form.set('name', artifact.name);
    if (artifact.release) form.set('release', artifact.release);
    if (artifact.arch) form.set('arch', artifact.arch);
    const type = artifact.gzip ? 'application/gzip' : artifact.kind === 'sourcemap' ? 'application/json' : 'application/octet-stream';
    form.set('file', new Blob([payload as Uint8Array<ArrayBuffer>], { type }), fileName);

    let retryAfter = 0;
    let error: UploadError;
    try {
      const response = await doFetch(artifactsUrl(connection), {
        method: 'POST',
        headers: { Authorization: `Bearer ${connection.authToken}`, 'User-Agent': 'zharp-cli' },
        body: form,
      });
      const text = await response.text().catch(() => '');
      if (response.ok) {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return text;
        }
      }
      error = describeFailure(response.status, text, connection);
      retryAfter = Number(response.headers.get('retry-after')) * 1000 || 0;
    } catch (cause) {
      error = new UploadError(`Could not reach ${connection.url}: ${(cause as Error)?.message ?? cause}`);
    }
    if (error.permanent || attempt >= retries) throw error;
    await sleep(Math.max(retryAfter, backoff * 2 ** attempt));
  }
}

function serverMessage(text: string): string {
  try {
    const body = JSON.parse(text);
    const message = body?.message ?? body?.error;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
  } catch {}
  return text.slice(0, 300);
}

function describeFailure(status: number, text: string, connection: Connection): UploadError {
  const detail = serverMessage(text);
  const retryable = status === 408 || status === 429 || status >= 500;
  const explain: Record<number, string> = {
    401: 'The auth token was rejected — check ZHARP_AUTH_TOKEN (a workspace API key, not the app key).',
    403: 'The API key cannot upload here — it needs the "artifacts:write" scope, in the workspace that owns the app.',
    404: `Application ${connection.app} was not found — check --app (the ID in the app's dashboard URL) and ZHARP_URL.`,
    413: 'The file is larger than the server accepts.',
  };
  const message = `${explain[status] ?? `Upload failed with HTTP ${status}.`}${detail ? ` Server said: ${detail}` : ''}`;
  return new UploadError(message, status, !retryable);
}

/** Run `fn` over `items`, `limit` at a time. Stops at the first error. */
export async function eachLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (failed === undefined && next < items.length) {
      const index = next++;
      try {
        await fn(items[index], index);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== undefined) throw failed;
}
