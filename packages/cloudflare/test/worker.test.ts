import { createExecutionContext, createMessageBatch, createScheduledController, env, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker, { honoWorker, onRequest, type Env } from './worker/index';
import { attrs, captured, errors, logs, reset, resource, spans } from './worker/collector';

const testEnv = env as unknown as Env;

async function call(target: { fetch?: Function }, path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response: Response = await target.fetch!(new Request(`https://shop.example${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function callAndSettle(target: { fetch?: Function }, path: string, init?: RequestInit): Promise<Response | Error> {
  try {
    return await call(target, path, init);
  } catch (error) {
    return error as Error;
  } finally {
    // The flush runs on waitUntil; a thrown handler still schedules it.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const server = () => spans().find((s) => s.kind === 2);
const byName = (name: string) => spans().find((s) => s.name === name);

beforeAll(async () => {
  await testEnv.DB.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT)');
  await testEnv.DB.exec("INSERT OR IGNORE INTO users (id, name) VALUES ('42', 'Ada')");
});

beforeEach(() => reset());

describe('fetch handler', () => {
  it('makes one SERVER span with the request, the response and Cloudflare attributes', async () => {
    const response = await call(worker, '/ok?token=abc&page=2', { headers: { 'user-agent': 'test-agent', authorization: 'Bearer x', 'cf-ray': '8a1b2c-AMS', 'cf-connecting-ip': '203.0.113.9' } });
    expect(await response.text()).toBe('ok');
    const span = server();
    expect(span.name).toBe('GET /ok');
    const a = attrs(span);
    expect(a['http.request.method']).toBe('GET');
    expect(a['http.response.status_code']).toBe(200);
    expect(a['url.full']).toBe('https://shop.example/ok?token=[Filtered]&page=2');
    expect(a['http.request.header.authorization']).toBe('[Filtered]');
    expect(a['http.request.header.user-agent']).toBe('test-agent');
    expect(a['http.response.header.set-cookie']).toBe('[Filtered]');
    expect(a['http.response.header.x-served-by']).toBe('test');
    expect(a['cloudflare.ray_id']).toBe('8a1b2c-AMS');
    expect(a['client.address']).toBe('203.0.113.9');
    expect(a['faas.trigger']).toBe('http');
    const r = resource();
    expect(r['service.name']).toBe('shop-worker');
    expect(r['service.version']).toBe('abc123');
    expect(r['cloud.provider']).toBe('cloudflare');
    expect(r['cloud.platform']).toBe('cloudflare.workers');
    expect(r['telemetry.sdk.name']).toBe('zharp');
    expect(captured[0].headers.authorization).toBe('Bearer zpk_test');
  });

  it('continues the caller’s traceparent', async () => {
    await call(worker, '/ok', { headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } });
    const span = server();
    expect(span.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span.parentSpanId).toBe('b7ad6b7169203331');
  });

  it('reports what the handler threw once, unhandled, and throws it on', async () => {
    const result = await callAndSettle(worker, '/throw');
    expect(result).toBeInstanceOf(TypeError);
    const [error, ...more] = errors();
    expect(more).toHaveLength(0);
    const a = attrs(error);
    expect(a['exception.type']).toBe('TypeError');
    expect(a['exception.message']).toContain('reading "total"');
    expect(a['exception.stacktrace']).toContain('at ');
    expect(a['zharp.handled']).toBe('false');
    const span = server();
    expect(span.status.code).toBe(2);
    expect(attrs(span)['http.response.status_code']).toBe(500);
    expect(error.traceId).toBe(span.traceId);
    expect(error.spanId).toBe(span.spanId);
  });

  it('counts an error captured and then thrown once', async () => {
    await callAndSettle(worker, '/rethrown');
    expect(errors()).toHaveLength(1);
    expect(attrs(errors()[0])['zharp.handled']).toBe('true');
  });

  it('reports failed waitUntil work, and flushes after it', async () => {
    await callAndSettle(worker, '/wait-until');
    const [error] = errors();
    expect(attrs(error)['exception.message']).toBe('failed after the response');
    expect(attrs(error)['zharp.mechanism']).toBe('waitUntil');
    expect(spans().some((s) => s.name === 'KV get KV')).toBe(true);
  });

  it('sets the user and tags on the request only, and sends captured errors, logs and manual spans', async () => {
    await call(worker, '/user');
    const [error] = errors();
    expect(attrs(error)['enduser.id']).toBe('7');
    expect(attrs(error)['plan']).toBe('pro');
    expect(attrs(error)['order.id']).toBe('o-1');
    expect(attrs(error)['zharp.handled']).toBe('true');
    const warn = logs().find((l) => l.severityText === 'WARN');
    expect(warn.body.stringValue).toBe('stock low');
    const manual = byName('render invoice');
    expect(attrs(manual)['invoice.lines']).toBe(3);
    expect(manual.parentSpanId).toBe(server().spanId);
    expect(attrs(server())['enduser.email']).toBe('ada@example.com');

    reset();
    await call(worker, '/ok');
    expect(attrs(server())['enduser.id']).toBeUndefined();
    expect(attrs(server())['plan']).toBeUndefined();
  });

  it('leaves console output alone unless ZHARP_LOGS is on', async () => {
    await call(worker, '/console');
    expect(logs()).toHaveLength(0);
  });
});

describe('D1', () => {
  it('makes a CLIENT span per query', async () => {
    const response = await call(worker, '/users/42');
    expect(await response.json()).toMatchObject({ name: 'Ada' });
    const query = spans().find((s) => attrs(s)['db.system'] === 'sqlite');
    expect(query.name).toBe('SELECT DB');
    expect(query.kind).toBe(3);
    expect(attrs(query)['db.statement']).toBe('SELECT * FROM users WHERE id = ?');
    expect(attrs(query)['db.namespace']).toBe('DB');
    expect(query.parentSpanId).toBe(server().spanId);
  });

  it('reports a failed query once, with its SQL and the line of the app that ran it', async () => {
    await callAndSettle(worker, '/d1-fail');
    const all = errors();
    expect(all).toHaveLength(1);
    const a = attrs(all[0]);
    expect(a['exception.type']).toBe('D1Error');
    expect(a['exception.message']).toContain('no such table');
    expect(a['db.statement']).toBe('SELECT * FROM missing_table WHERE id = ?');
    expect(a['db.error.code']).toBe('SQLITE_ERROR');
    expect(a['zharp.handled']).toBe('false');
    // The stack starts at the app's own call, not inside D1 or the SDK.
    const firstFrame = a['exception.stacktrace'].split('\n')[1];
    expect(firstFrame).toMatch(/at Object\.fetch|at fetch/);
    expect(firstFrame).toContain('worker/index.ts');
  });

  it('reports a failed query the app caught as handled, at the end of the request', async () => {
    const response = await call(worker, '/d1-caught');
    expect(response.status).toBe(409);
    const all = errors();
    expect(all).toHaveLength(1);
    expect(attrs(all[0])['zharp.handled']).toBe('true');
    expect(attrs(all[0])['db.error.code']).toMatch(/SQLITE_CONSTRAINT/);
  });

  it('names a batch by its statements', async () => {
    await call(worker, '/d1-batch');
    const batch = spans().find((s) => s.name === 'BATCH DB');
    expect(attrs(batch)['db.statement']).toBe('SELECT 1;\nSELECT 2');
  });
});

describe('bindings and outgoing requests', () => {
  it('traces KV, R2 and queue sends', async () => {
    await call(worker, '/kv');
    expect(spans().map((s) => s.name)).toEqual(expect.arrayContaining(['KV put KV', 'KV get KV']));
    expect(attrs(byName('KV get KV'))['cloudflare.kv.hit']).toBe(true);
    reset();
    await call(worker, '/r2');
    expect(spans().map((s) => s.name)).toEqual(expect.arrayContaining(['R2 put BUCKET', 'R2 get BUCKET']));
    reset();
    await call(worker, '/queue');
    const send = byName('QUEUE send');
    expect(send.kind).toBe(4);
    expect(attrs(send)['messaging.system']).toBe('cloudflare_queues');
  });

  it('adds traceparent to outgoing fetches, in a CLIENT span of the same trace', async () => {
    const response = await call(worker, '/outgoing');
    const echoed = await response.json<{ traceparent: string }>();
    const client = spans().find((s) => s.kind === 3 && s.name === 'GET origin.test');
    expect(echoed.traceparent).toBe(`00-${client.traceId}-${client.spanId}-01`);
    expect(client.traceId).toBe(server().traceId);
    expect(attrs(client)['http.request.header.authorization']).toBe('[Filtered]');
    expect(attrs(client)['http.response.status_code']).toBe(200);
    // Zharp's own requests are not traced.
    expect(spans().some((s) => attrs(s)['url.full']?.includes('otlp.test'))).toBe(false);
  });

  it('marks a failed outgoing fetch, and reports the error the handler threw once', async () => {
    await callAndSettle(worker, '/outgoing-down');
    const client = spans().find((s) => s.kind === 3);
    expect(client.status.code).toBe(2);
    expect(errors()).toHaveLength(1);
  });
});

describe('Durable Objects', () => {
  it('traces fetch into the object, continuing the trace through the stub', async () => {
    const response = await call(worker, '/do');
    const body = await response.json<{ count: number; traceparent: string }>();
    expect(body.count).toBeGreaterThan(0);
    const inside = spans().find((s) => attrs(s)['cloudflare.durable_object.class'] === 'CounterObject' && s.kind === 2);
    expect(inside.traceId).toBe(server().traceId);
    expect(body.traceparent).toContain(inside.parentSpanId);
    // KV used inside the object belongs to it.
    expect(spans().find((s) => s.name === 'KV put KV').parentSpanId).toBe(inside.spanId);
  });

  it('traces RPC methods, and reports what they throw', async () => {
    const response = await call(worker, '/do-rpc');
    expect(await response.json()).toEqual({ value: 5 });
    expect(spans().some((s) => s.name === 'CounterObject.increment')).toBe(true);
    reset();
    await callAndSettle(worker, '/do-fail');
    await new Promise((r) => setTimeout(r, 100));
    expect(errors().some((e) => attrs(e)['exception.message'] === 'counter exploded' && attrs(e)['zharp.mechanism'] === 'cloudflare.rpc')).toBe(true);
  });
});

describe('scheduled and queue handlers', () => {
  it('makes a span per cron run', async () => {
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: '*/5 * * * *', scheduledTime: Date.now() }) as any, testEnv as any, ctx);
    await waitOnExecutionContext(ctx);
    const span = byName('cron */5 * * * *');
    expect(attrs(span)['faas.trigger']).toBe('timer');
    expect(spans().find((s) => s.name === 'KV put KV').parentSpanId).toBe(span.spanId);
  });

  it('makes a CONSUMER span per batch, and reports what it throws', async () => {
    const batch = createMessageBatch('orders', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: { order: 1 } },
      { id: 'm2', timestamp: new Date(), attempts: 1, body: { poison: true } },
    ]);
    const ctx = createExecutionContext();
    await expect(worker.queue!(batch as any, testEnv as any, ctx)).rejects.toThrow('poison message');
    await waitOnExecutionContext(ctx);
    await getQueueResult(batch, ctx).catch(() => undefined);
    const span = byName('orders process');
    expect(span.kind).toBe(5);
    expect(attrs(span)['messaging.batch.message_count']).toBe(2);
    expect(errors()).toHaveLength(1);
  });
});

describe('Hono', () => {
  it('names the span after the matched route', async () => {
    await call(honoWorker, '/items/42');
    expect(server().name).toBe('GET /items/:id');
    expect(attrs(server())['http.route']).toBe('/items/:id');
  });

  it('reports errors Hono turns into a 500, once; not HTTPExceptions under 500', async () => {
    const response = await call(honoWorker, '/broken');
    expect(response.status).toBe(500);
    expect(errors()).toHaveLength(1);
    expect(attrs(errors()[0])['zharp.mechanism']).toBe('hono');
    expect(server().name).toBe('GET /broken');
    reset();
    const forbidden = await call(honoWorker, '/forbidden');
    expect(forbidden.status).toBe(403);
    expect(errors()).toHaveLength(0);
  });
});

describe('Pages Functions', () => {
  it('traces the request through the middleware, and the bindings of the functions after it', async () => {
    const request = new Request('https://site.example/api/users/42');
    const execution = createExecutionContext();
    // What Pages hands a function: the functions after the middleware share its env object.
    const pagesEnv: Record<string, unknown> = { ...(testEnv as any) };
    const context = {
      request,
      env: pagesEnv,
      params: {},
      data: {},
      functionPath: '/api/users/[id]',
      waitUntil: (promise: Promise<unknown>) => execution.waitUntil(promise),
      passThroughOnException: () => undefined,
      next: async () => Response.json(await (pagesEnv.DB as D1Database).prepare('SELECT * FROM users WHERE id = ?').bind('42').first()),
    };
    const response = await onRequest(context as any);
    expect(response.status).toBe(200);
    await waitOnExecutionContext(execution);
    expect(server().name).toBe('GET /api/users/:id');
    expect(attrs(server())['url.path']).toBe('/api/users/42');
    expect(spans().some((s) => attrs(s)['db.system'] === 'sqlite')).toBe(true);
  });
});
