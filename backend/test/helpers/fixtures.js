/**
 * Test fixtures for cross-system verification:
 *
 *  - startMockApi(): a small REST service (orders/products) with auth-gated,
 *    slow, erroring and mutating endpoints — the mock the REST connector
 *    talks to;
 *  - createFixtureDb(): an isolated SQLite file (orders + products) for the
 *    SQL connector, created read-write by the fixture and used read-only.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function startMockApi() {
  const orders = new Map([
    ['ORD-1001', { id: 'ORD-1001', status: 'CONFIRMED', total: 115999, product_sku: 'IPH17P-256' }],
    ['ORD-1002', { id: 'ORD-1002', status: 'PENDING', total: 49, product_sku: 'TABLE-01' }],
  ]);
  const products = new Map([
    ['IPH17P-256', { sku: 'IPH17P-256', name: 'iPhone 17 Pro', price: 118999, in_stock: true }],
    ['TABLE-01', { sku: 'TABLE-01', name: 'Wooden Table', price: 49, in_stock: false }],
  ]);

  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Auth-gated endpoint: rejects anything but the expected bearer token.
      if (url.pathname.startsWith('/secure/')) {
        const auth = req.headers.authorization ?? '';
        const expected = `Bearer ${process.env.MOCK_API_TOKEN ?? 'secret-token'}`;
        if (auth !== expected) return json(401, { error: 'unauthorized' });
        const orderId = url.pathname.split('/').pop();
        const order = orders.get(orderId);
        return order ? json(200, order) : json(404, { error: 'not found', id: orderId });
      }

      if (url.pathname === '/slow') {
        const delay = Number(url.searchParams.get('ms') ?? 3000);
        setTimeout(() => json(200, { status: 'late' }), delay).unref?.();
        return;
      }

      if (url.pathname === '/error') return json(500, { error: 'boom' });

      const orderMatch = url.pathname.match(/^\/orders\/([^/]+)$/);
      if (orderMatch) {
        const order = orders.get(orderMatch[1]);
        return order ? json(200, order) : json(404, { error: 'not found', id: orderMatch[1] });
      }

      const productMatch = url.pathname.match(/^\/products\/([^/]+)$/);
      if (productMatch) {
        const product = products.get(productMatch[1]);
        return product ? json(200, product) : json(404, { error: 'not found', sku: productMatch[1] });
      }

      if (url.pathname === '/orders' && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* echo raw */ }
        return json(201, { id: 'ORD-NEW', ...parsed, created: true });
      }

      if (url.pathname === '/echo' && req.method === 'POST') {
        return json(200, { received: body || null });
      }

      json(404, { error: 'no route', path: url.pathname });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.close(r);
            // Aborted/slow requests leave sockets open; destroy them so close()
            // completes and the test process can exit.
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/**
 * Isolated SQLite fixture with orders + products.
 * @param {{ divergentOrder?: boolean, extraOrder?: object }} options
 *   `divergentOrder` writes ORD-1001 with a different total, so a
 *   REST-vs-SQL comparison genuinely mismatches.
 */
export function createFixtureDb({ divergentOrder = false, withExtraOrder = true } = {}) {
  const dbPath = path.join(os.tmpdir(), `flowfix-fixture-${crypto.randomUUID()}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      total INTEGER NOT NULL,
      product_sku TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE products (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      in_stock INTEGER NOT NULL
    );
  `);

  const insertOrder = db.prepare('INSERT INTO orders (id, status, total, product_sku, created_at) VALUES (?, ?, ?, ?, ?)');
  insertOrder.run('ORD-1001', 'CONFIRMED', divergentOrder ? 99999 : 115999, 'IPH17P-256', '2026-10-25T10:00:00.000Z');
  if (withExtraOrder) insertOrder.run('ORD-1002', 'PENDING', 49, 'TABLE-01', '2026-10-25T10:05:00.000Z');

  const insertProduct = db.prepare('INSERT INTO products (sku, name, price, in_stock) VALUES (?, ?, ?, ?)');
  insertProduct.run('IPH17P-256', 'iPhone 17 Pro', 118999, 1);
  insertProduct.run('TABLE-01', 'Wooden Table', 49, 0);

  db.close();

  return {
    path: dbPath,
    cleanup() {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    },
  };
}
