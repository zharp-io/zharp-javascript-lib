/**
 * Settings from code and from the Worker's environment. Code wins; then the `ZHARP_*` vars and
 * secrets; then what Cloudflare itself says about the deployment.
 */
import type { CaptureHeaders } from '@zharp/internal/headers';
import type { ZharpCloudflareOptions, ZharpConfig } from './types';
import { VERSION } from './version';

export const DEFAULT_ENDPOINT = 'https://api.zharp.io/api/v1/otlp';

export interface Settings {
  key: string;
  endpoint: string;
  sampleRate: number;
  tracing: boolean;
  logs: boolean;
  captureHeaders: CaptureHeaders | undefined;
  captureQueryErrors: boolean;
  ignoreUrls: Array<string | RegExp>;
  resource: Record<string, unknown>;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const flag = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  const t = text(value)?.toLowerCase();
  if (!t) return undefined;
  if (/^(true|1|yes|on)$/.test(t)) return true;
  if (/^(false|0|no|off)$/.test(t)) return false;
  return undefined;
};

/** `CF_VERSION_METADATA` (or any binding shaped like it): the deployed version's id and tag. */
function versionMetadata(env: Record<string, unknown>): { id?: string; tag?: string } {
  const named = env.CF_VERSION_METADATA as { id?: unknown; tag?: unknown } | undefined;
  if (named && typeof named === 'object') return { id: text(named.id), tag: text(named.tag) };
  return {};
}

/**
 * The settings, or null when there is no key or `ZHARP_DISABLED` is set.
 * @param defaults - What the entry point stands for: a Worker or Pages.
 */
export function resolveSettings(envInput: unknown, config: ZharpConfig | undefined, defaults: { service: string; platform: string }): Settings | null {
  const env = (envInput && typeof envInput === 'object' ? envInput : {}) as Record<string, unknown>;
  const options: ZharpCloudflareOptions = (typeof config === 'function' ? config(env) : config) ?? {};
  if (flag(env.ZHARP_DISABLED)) return null;
  const key = text(options.key) ?? text(env.ZHARP_KEY) ?? text(env.ZHARP_API_KEY);
  if (!key) return null;

  const version = versionMetadata(env);
  const release = text(options.release) ?? text(env.ZHARP_RELEASE) ?? version.id;
  const rate = typeof options.sampleRate === 'number' ? options.sampleRate : Number(text(env.ZHARP_SAMPLE_RATE) ?? 1);
  const headersEnv = flag(env.ZHARP_CAPTURE_HEADERS);

  return {
    key,
    endpoint: (text(options.endpoint) ?? text(env.ZHARP_ENDPOINT) ?? DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1,
    tracing: options.tracing ?? flag(env.ZHARP_TRACING) ?? true,
    logs: options.logs ?? flag(env.ZHARP_LOGS) ?? false,
    captureHeaders: options.captureHeaders ?? (headersEnv === false ? false : undefined),
    captureQueryErrors: options.captureQueryErrors ?? true,
    ignoreUrls: options.ignoreUrls ?? [],
    resource: {
      'service.name': text(options.service) ?? text(env.ZHARP_SERVICE) ?? defaults.service,
      'service.version': release,
      'deployment.environment.name': text(options.environment) ?? text(env.ZHARP_ENVIRONMENT) ?? text(env.ZHARP_ENV),
      'telemetry.sdk.name': 'zharp',
      'telemetry.sdk.language': 'webjs',
      'telemetry.sdk.version': VERSION,
      'cloud.provider': 'cloudflare',
      'cloud.platform': defaults.platform,
      'faas.version': version.id,
      'cloudflare.version.tag': version.tag,
    },
  };
}
