// Regression tests for the Oct 2026 security assessment fixes.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');

process.env.PORT = '0';
process.env.LAS_HOST = '127.0.0.1';
process.env.LAS_API_TOKEN = 'test-token-123';
process.env.LAS_TRUST_PROXY = '1';
process.env.LAS_RATE_PER_HOUR = '2';
delete process.env.SUPABASE_URL; // SaaS layer off
delete process.env.LAS_PROXY;
delete process.env.LAS_CORS_ORIGINS;

const { start } = require('../server/public-server');
const { startEgressGuard, resolvePublic } = require('../server/egress-guard');

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on('error', reject);
  });
}

let server; let port;
test.before(async () => { server = await start(); port = server.address().port; });
test.after(() => { if (server) server.close(); setTimeout(() => process.exit(0), 200).unref(); });

const internal = '/api/media-info?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/');

test('M1: forged Origin / Sec-Fetch-Site / Host without token is rejected', async () => {
  const r = await get(port, internal, { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Host': `127.0.0.1:${port}`, 'CF-Connecting-IP': '203.0.113.9' });
  assert.strictEqual(r.status, 401);
});

test('M1: wrong token rejected, valid token accepted (then SSRF check refuses the internal URL)', async () => {
  assert.strictEqual((await get(port, internal, { 'X-LAS-Token': 'nope', 'CF-Connecting-IP': '203.0.113.10' })).status, 401);
  const ok = await get(port, internal, { 'X-LAS-Token': 'test-token-123', 'CF-Connecting-IP': '203.0.113.10' });
  assert.strictEqual(ok.status, 400);
});

test('M2: spoofed X-Forwarded-For does not reset the rate limit', async () => {
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const r = await get(port, internal, { 'X-LAS-Token': 'test-token-123', 'CF-Connecting-IP': '198.51.100.7', 'X-Forwarded-For': `10.9.9.${i}, 198.51.100.7, 172.71.0.1` });
    codes.push(r.status);
  }
  assert.deepStrictEqual(codes, [400, 400, 429]);
});

test('M2: without CF-Connecting-IP the right-hand XFF hop is used, not the left-most', async () => {
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const r = await get(port, internal, { 'X-LAS-Token': 'test-token-123', 'X-Forwarded-For': `1.2.3.${i}, 192.0.2.44, 172.71.0.1, 10.0.0.1` });
    codes.push(r.status);
  }
  assert.deepStrictEqual(codes, [400, 400, 429]);
});

test('M4 / L2: HSTS present, CORS no longer *', async () => {
  const r = await get(port, '/health', { Origin: 'https://evil.example' });
  assert.match(r.headers['strict-transport-security'] || '', /max-age=604800/);
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
  const ok = await get(port, '/health', { Origin: 'https://lasconverter.lasgconcept.com' });
  assert.strictEqual(ok.headers['access-control-allow-origin'], 'https://lasconverter.lasgconcept.com');
  for (const o of ['https://localhost', 'capacitor://localhost', 'http://127.0.0.1:3000']) {
    assert.strictEqual((await get(port, '/health', { Origin: o })).headers['access-control-allow-origin'], o);
  }
});

test('M3: egress guard refuses internal destinations', async () => {
  for (const h of ['169.254.169.254', '127.0.0.1', '10.0.0.5', '192.168.1.1', 'localhost', '::1', 'metadata.internal']) {
    await assert.rejects(resolvePublic(h), undefined, h);
  }
  // A hostname whose DNS answer is internal (rebinding) is refused too.
  await assert.rejects(resolvePublic('evil.example', { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }));
  await assert.rejects(resolvePublic('mixed.example', { lookup: async () => [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }] }));
  assert.strictEqual((await resolvePublic('1.1.1.1')).address, '1.1.1.1');
});

test('M3: guard proxy blocks CONNECT and http requests to internal targets', async () => {
  const target = http.createServer((q, s) => s.end('SECRET')).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  const tport = target.address().port;
  const g = await startEgressGuard();
  try {
    const connectStatus = await new Promise((resolve) => {
      const s = net.connect(g.port, '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:${tport} HTTP/1.1\r\nHost: 127.0.0.1:${tport}\r\n\r\n`));
      s.once('data', (d) => { resolve(String(d).split(' ')[1]); s.destroy(); });
    });
    assert.strictEqual(connectStatus, '403');
    const r = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: g.port, path: `http://127.0.0.1:${tport}/`, headers: { Host: `127.0.0.1:${tport}` } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
    });
    assert.strictEqual(r.status, 403);
    assert.doesNotMatch(r.body, /SECRET/);
  } finally { await g.close(); target.close(); }
});
