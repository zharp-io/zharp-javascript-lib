/**
 * Stands in for the network: OTLP sent to https://otlp.test is decoded and kept for the tests,
 * and https://origin.test answers like an API that echoes what it was sent. Installed before the
 * SDK starts, so the SDK's own requests and the app's both come here.
 */
export interface Captured {
  signal: string;
  body: any;
  headers: Record<string, string>;
}

export const captured: Captured[] = [];
export const reset = () => {
  captured.length = 0;
};

async function text(request: Request): Promise<string> {
  if (request.headers.get('content-encoding') === 'gzip') {
    return new Response(request.body!.pipeThrough(new DecompressionStream('gzip'))).text();
  }
  return request.text();
}

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input as RequestInfo, init);
  const url = new URL(request.url);
  if (url.host === 'otlp.test') {
    const signal = url.pathname.split('/').pop()!;
    captured.push({ signal, body: JSON.parse(await text(request)), headers: Object.fromEntries(request.headers) });
    return new Response('{}', { status: 200 });
  }
  if (url.host === 'origin.test') {
    if (url.pathname === '/down') throw new TypeError('Network connection lost.');
    return Response.json({ traceparent: request.headers.get('traceparent'), path: url.pathname }, { status: url.pathname === '/missing' ? 404 : 200 });
  }
  return new Response('not found', { status: 404 });
};

globalThis.fetch = stub as typeof fetch;

/** Attributes of an OTLP record as a plain object. */
export function attrs(record: { attributes?: Array<{ key: string; value: any }> }): Record<string, any> {
  const out: Record<string, any> = {};
  for (const { key, value } of record.attributes ?? []) out[key] = value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? value;
  return out;
}

export function spans(): any[] {
  return captured.filter((c) => c.signal === 'traces').flatMap((c) => c.body.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
}

export function logs(): any[] {
  return captured.filter((c) => c.signal === 'logs').flatMap((c) => c.body.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords)));
}

export function errors(): any[] {
  return logs().filter((record) => attrs(record)['exception.type']);
}

export function resource(): Record<string, any> {
  const first = captured.find((c) => c.signal === 'traces' || c.signal === 'logs');
  const r = first?.body.resourceSpans?.[0]?.resource ?? first?.body.resourceLogs?.[0]?.resource;
  return r ? attrs(r) : {};
}
