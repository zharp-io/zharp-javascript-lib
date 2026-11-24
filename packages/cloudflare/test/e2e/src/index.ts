import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { instrumentDurableObject, withZharp, Zharp } from '../../../dist/index.mjs';
import { cartTotal } from './cart';

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  CART: DurableObjectNamespace<CartObject>;
  ORIGIN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

app.get('/checkout/:id', async (c) => {
  Zharp.setUser({ id: 'u-1', email: 'ada@example.com' });
  await c.env.KV.put(`seen:${c.req.param('id')}`, '1');
  const total = cartTotal([{ sku: 'A1', quantity: 2, price: { amount: 5 } }, { sku: 'B2', quantity: 1 }]);
  return c.json({ total });
});

app.get('/total', (c) => c.json({ total: cartTotal([{ sku: 'B2', quantity: 1 }]) }));

app.get('/orders/:id', async (c) => {
  await c.env.DB.exec('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, total INTEGER)');
  const order = await c.env.DB.prepare('SELECT * FROM order_lines WHERE order_id = ?').bind(c.req.param('id')).all();
  return c.json(order);
});

app.get('/origin', async (c) => {
  const response = await fetch(`${c.env.ORIGIN}/echo`);
  return c.json(await response.json());
});

app.get('/cart/:id', async (c) => {
  const stub = c.env.CART.getByName(c.req.param('id'));
  return c.json({ items: await stub.add('A1') });
});

app.get('/log', (c) => {
  console.log('checkout started', { cart: 'c-1' });
  console.error(new Error('logged, not thrown'));
  return c.text('logged');
});

export class CartObject extends DurableObject<Env> {
  async add(sku: string): Promise<string[]> {
    const items = ((await this.ctx.storage.get<string[]>('items')) ?? []).concat(sku);
    await this.ctx.storage.put('items', items);
    return items;
  }
}

export const Cart = instrumentDurableObject(CartObject);

export default withZharp(app);
