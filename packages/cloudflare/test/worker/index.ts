/**
 * A Worker that does what real ones do — D1, KV, R2, a queue, a Durable Object, outgoing
 * fetches, Hono — wrapped with @zharp/cloudflare, for the tests to call.
 */
import './collector';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { instrumentDurableObject, withZharp, Zharp, zharpPagesPlugin } from '../../src/index';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  BUCKET: R2Bucket;
  QUEUE: Queue;
  COUNTER: DurableObjectNamespace<CounterObject>;
}

const config = () => ({ key: 'zpk_test', endpoint: 'https://otlp.test/api/v1/otlp', service: 'shop-worker', release: 'abc123' });

async function loadUser(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/ok':
        return new Response('ok', { headers: { 'set-cookie': 'session=secret', 'x-served-by': 'test' } });
      case '/throw':
        throw new TypeError('Cannot read properties of undefined (reading "total")');
      case '/rethrown': {
        const error = new RangeError('reported once');
        Zharp.captureError(error);
        throw error;
      }
      case '/users/42':
        return Response.json(await loadUser(env.DB, '42'));
      case '/d1-fail':
        await env.DB.prepare('SELECT * FROM missing_table WHERE id = ?').bind(1).all();
        return new Response('unreachable');
      case '/d1-caught':
        try {
          await env.DB.prepare('INSERT INTO users (id, name) VALUES (?, ?)').bind('42', 'dup').run();
        } catch {
          return new Response('caught', { status: 409 });
        }
        return new Response('inserted');
      case '/d1-batch':
        await env.DB.batch([env.DB.prepare('SELECT 1'), env.DB.prepare('SELECT 2')]);
        return new Response('batched');
      case '/kv':
        await env.KV.put('greeting', 'hi');
        return new Response(await env.KV.get('greeting'));
      case '/r2':
        await env.BUCKET.put('a.txt', 'hello');
        return new Response(await (await env.BUCKET.get('a.txt'))!.text());
      case '/queue':
        await env.QUEUE.send({ order: 1 });
        return new Response('queued');
      case '/outgoing': {
        const response = await fetch('https://origin.test/echo', { headers: { authorization: 'Bearer secret' } });
        return new Response(await response.text());
      }
      case '/outgoing-down':
        await fetch('https://origin.test/down');
        return new Response('unreachable');
      case '/do':
        return env.COUNTER.get(env.COUNTER.idFromName('a')).fetch('https://counter/increment');
      case '/do-rpc':
        return Response.json({ value: await env.COUNTER.getByName('b').increment(5) });
      case '/do-fail':
        return Response.json({ value: await env.COUNTER.getByName('c').explode() });
      case '/wait-until':
        ctx.waitUntil(
          (async () => {
            await env.KV.get('later');
            throw new Error('failed after the response');
          })(),
        );
        return new Response('accepted', { status: 202 });
      case '/user':
        Zharp.setUser({ id: 7, email: 'ada@example.com' });
        Zharp.setTag('plan', 'pro');
        Zharp.captureError(new Error('handled one'), { 'order.id': 'o-1' });
        Zharp.log.warn('stock low', { sku: 'A1' });
        return Zharp.startSpan('render invoice', async (span) => {
          span.setAttribute('invoice.lines', 3);
          return new Response('ok');
        });
      case '/console':
        console.log('a console line');
        return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env) {
    await env.KV.put('last-run', String(controller.scheduledTime));
  },

  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) await env.KV.put(`order-${message.id}`, JSON.stringify(message.body));
    if (batch.messages.some((m: any) => m.body?.poison)) throw new Error('poison message');
  },
};

export default withZharp(config, handler);

// ── Hono ────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (_c, next) => {
  await next();
});
app.get('/items/:id', async (c) => c.json({ id: c.req.param('id'), user: await loadUser(c.env.DB, c.req.param('id')) }));
app.get('/broken', () => {
  throw new Error('route failed');
});
app.get('/forbidden', () => {
  throw new HTTPException(403, { message: 'no' });
});
export const honoWorker = withZharp(config, app);

// ── Durable Object ──────────────────────────────────────────────────────

export class CounterObject extends DurableObject<Env> {
  #count = 0;

  async fetch(request: Request): Promise<Response> {
    this.#count = await this.increment(1);
    return Response.json({ count: this.#count, path: new URL(request.url).pathname, traceparent: request.headers.get('traceparent') });
  }

  async increment(by: number): Promise<number> {
    const value = ((await this.ctx.storage.get<number>('count')) ?? 0) + by;
    await this.ctx.storage.put('count', value);
    await this.env.KV.put('counter', String(value));
    return value;
  }

  async explode(): Promise<number> {
    throw new Error('counter exploded');
  }

  async alarm(): Promise<void> {
    await this.increment(1);
  }
}

export const Counter = instrumentDurableObject(CounterObject, config);

// ── Pages Functions ─────────────────────────────────────────────────────

export const onRequest = zharpPagesPlugin(config);
