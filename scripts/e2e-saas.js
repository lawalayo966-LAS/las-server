#!/usr/bin/env node
/**
 * Local end-to-end run of the SaaS server with MOCKED Supabase (auth JWKS +
 * PostgREST), Cloudflare R2 (S3 API) and Paystack, and a REAL Facebook
 * download through yt-dlp. Usage: node scripts/e2e-saas.js [facebook-url]
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const FB = process.argv[2] || 'https://www.facebook.com/share/v/1HqoBicskY/';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PSK = 'sk_test_e2e_only';

const db = { profiles: new Map(), usage: new Map(), downloads: [], payments: new Map() };
const objects = new Map();
const ok = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });

const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const body = await readBody(req);
  const j = () => JSON.parse(body.toString() || '{}');
  if (u.pathname === '/auth/v1/.well-known/jwks.json') return ok(res, 200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'ES256' }] });
  if (u.pathname.startsWith('/rest/v1/')) {
    if (req.headers.apikey !== 'service-e2e') return ok(res, 401, { message: 'bad service key' });
    const p = u.pathname.slice(9); const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
    if (p === 'profiles' && req.method === 'GET') return ok(res, 200, db.profiles.has(eq('id')) ? [db.profiles.get(eq('id'))] : []);
    if (p === 'profiles' && req.method === 'PATCH') { Object.assign(db.profiles.get(eq('id')), j()); return ok(res, 204); }
    if (p === 'rpc/consume_download') { const { p_user: uid, p_limit: lim } = j(); const n = db.usage.get(uid) || 0; if (n >= lim) return ok(res, 200, [{ allowed: false, used: n }]); db.usage.set(uid, n + 1); return ok(res, 200, [{ allowed: true, used: n + 1 }]); }
    if (p === 'rpc/usage_today') return ok(res, 200, db.usage.get(j().p_user) || 0);
    if (p === 'downloads' && req.method === 'POST') { db.downloads.push({ ...j(), created_at: new Date().toISOString() }); return ok(res, 201); }
    if (p === 'downloads' && req.method === 'GET') return ok(res, 200, db.downloads.filter((d) => d.user_id === eq('user_id')));
    if (p === 'payments' && req.method === 'POST') { const r = j(); db.payments.set(r.reference, r); return ok(res, 201); }
    if (p === 'payments' && req.method === 'GET') { const r = db.payments.get(eq('reference')); return ok(res, 200, r ? [r] : []); }
    if (p === 'payments' && req.method === 'PATCH') { Object.assign(db.payments.get(eq('reference')), j()); return ok(res, 204); }
  }
  if (u.pathname === '/paystack/transaction/initialize') return ok(res, 200, { status: true, data: { authorization_url: `https://checkout.paystack.com/${j().reference}`, access_code: 'ac', reference: j().reference } });
  if (u.pathname.startsWith('/paystack/transaction/verify/')) { const ref = decodeURIComponent(u.pathname.split('/').pop()); const p = db.payments.get(ref); return ok(res, 200, { status: true, data: { status: 'success', amount: p.amount, currency: 'NGN', reference: ref } }); }
  if (u.pathname.startsWith('/s3/')) { // R2 (path-style S3)
    const key = decodeURIComponent(u.pathname.slice(4));
    if (req.method === 'PUT') { if (!/AWS4-HMAC-SHA256/.test(req.headers.authorization || '')) return ok(res, 403); objects.set(key, body); res.writeHead(200, { ETag: '"e2e"' }); return res.end(); }
    if (req.method === 'GET') { if (!u.searchParams.get('X-Amz-Signature')) return ok(res, 403); const o = objects.get(key); if (!o) return ok(res, 404); res.writeHead(200, { 'Content-Length': o.length, 'Content-Disposition': u.searchParams.get('response-content-disposition') || '' }); return res.end(o); }
  }
  ok(res, 404, { message: `unmocked ${req.method} ${u.pathname}` });
});

function token(base, sub, email) {
  const data = `${b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'e2e' }))}.${b64u(JSON.stringify({ sub, email, role: 'authenticated', aud: 'authenticated', iss: `${base}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
  return `${data}.${b64u(crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }))}`;
}
const step = (s) => console.log(`\n== ${s}`);
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) process.exitCode = 1; };

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const M = `http://127.0.0.1:${mock.address().port}`;
  const PORT = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'public-server.js')], {
    env: { ...process.env, PORT: String(PORT), LAS_HOST: '127.0.0.1', LAS_API_TOKEN: 'app-token-e2e', LAS_WEB_DIR: '/nonexistent',
      SUPABASE_URL: M, SUPABASE_SERVICE_ROLE_KEY: 'service-e2e', PAYSTACK_SECRET_KEY: PSK, PAYSTACK_API_BASE: `${M}/paystack`,
      R2_ENDPOINT: `${M}/s3`, R2_BUCKET: 'las-e2e', R2_ACCESS_KEY_ID: 'AKIDE2E', R2_SECRET_ACCESS_KEY: 'secret-e2e', LAS_CORS_ORIGINS: 'https://lasconverter.com,https://*.vercel.app',
      LAS_MAX_DURATION_SEC: '1200', LAS_RATE_PER_HOUR: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; srv.stdout.on('data', (d) => logs.push(String(d))); srv.stderr.on('data', (d) => logs.push(String(d)));
  const S = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${S}/api/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 200)); }
  try {
    db.profiles.set('u-free', { id: 'u-free', email: 'free@example.com', plan: 'free', plan_expires_at: null });
    db.profiles.set('u-pro', { id: 'u-pro', email: 'pro@example.com', plan: 'free', plan_expires_at: null });
    const FREE = { Authorization: `Bearer ${token(M, 'u-free', 'free@example.com')}` };
    const PRO = { Authorization: `Bearer ${token(M, 'u-pro', 'pro@example.com')}` };
    const enc = encodeURIComponent(FB);

    step('auth + CORS');
    check((await fetch(`${S}/api/me`)).status === 401, '/api/me without login -> 401');
    check((await fetch(`${S}/api/me`, { headers: { Authorization: 'Bearer abc.def.ghi' } })).status === 401, 'forged token -> 401');
    const me = await (await fetch(`${S}/api/me`, { headers: FREE })).json();
    check(me.plan === 'free' && me.limits.dailyDownloads === 10 && me.limits.maxHeight === 720, `/api/me free: ${JSON.stringify({ plan: me.plan, limits: me.limits })}`);
    const pre = await fetch(`${S}/api/jobs`, { method: 'OPTIONS', headers: { Origin: 'https://las-web-git-main.vercel.app' } });
    check(pre.headers.get('access-control-allow-origin') === 'https://las-web-git-main.vercel.app' && /Authorization/.test(pre.headers.get('access-control-allow-headers')), 'CORS allows the Vercel preview origin + Authorization');
    const bad = await fetch(`${S}/api/jobs`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    check(!bad.headers.get('access-control-allow-origin'), 'CORS refuses other origins');

    step('analyze (free): options above 720p are marked premium');
    const info = await (await fetch(`${S}/api/media-info?url=${enc}`, { headers: FREE })).json();
    console.log('   options:', (info.options || []).map((o) => `${o.tag}${o.premium ? '*' : ''}`).join(' '));
    check(info.success && info.options.some((o) => o.premium) && info.options.some((o) => o.tag === 'mp3-320' && o.premium), 'premium options flagged (incl. MP3 320k)');

    step('free user: MP3 320k refused (402); a 1920p request is capped to 720p (short side), no cloud copy');
    const r320 = await fetch(`${S}/api/jobs?url=${enc}&format=mp3&bitrate=320`, { method: 'POST', headers: FREE });
    check(r320.status === 402, 'MP3 320 -> 402');
    const job = async (h, q) => {
      const s = await (await fetch(`${S}/api/jobs?url=${enc}&format=mp4&quality=${q}`, { method: 'POST', headers: h })).json();
      let j = s; while (j.state === 'running' || j.state === 'queued') { await new Promise((r) => setTimeout(r, 1500)); j = await (await fetch(`${S}/api/jobs/${s.id}`, { headers: h })).json(); }
      return j;
    };
    const jf = await job(FREE, 1920);
    check(jf.state === 'done' && jf.size > 0 && !jf.cloudUrl, `free job (asked 1920p) done: ${jf.size} bytes, cloudUrl=${jf.cloudUrl || 'none'}`);
    check((await fetch(`${S}/api/jobs/${jf.id}`, { headers: PRO })).status === 404, "another user can't read this job");
    check((await fetch(`${S}/api/jobs/${jf.id}/file`, { headers: { ...FREE, Range: 'bytes=0-99' } })).status === 206, 'owner can fetch the file (Range 206)');
    check(db.downloads.some((d) => d.user_id === 'u-free' && !d.r2_key), 'history row written (no R2 copy)');

    step('free quota: 10/day enforced server-side');
    db.usage.set('u-free', 10);
    const q = await fetch(`${S}/api/jobs?url=${enc}&format=mp4&quality=360`, { method: 'POST', headers: FREE });
    const qj = await q.json();
    check(q.status === 429 && qj.code === 'quota_exceeded', `11th download -> 429: ${qj.error}`);

    step('upgrade via Paystack: initialize + signed webhook');
    const init = await (await fetch(`${S}/api/pay/initialize`, { method: 'POST', headers: { ...PRO, 'Content-Type': 'application/json' }, body: '{"plan":"monthly"}' })).json();
    check(/^https:\/\/checkout\.paystack\.com\//.test(init.authorizationUrl) && db.payments.get(init.reference).amount === 150000, `initialize -> ${init.reference} (₦1,500)`);
    const evt = JSON.stringify({ event: 'charge.success', data: { reference: init.reference, amount: 150000, currency: 'NGN' } });
    const forged = await fetch(`${S}/api/pay/webhook`, { method: 'POST', headers: { 'x-paystack-signature': 'deadbeef' }, body: evt });
    check(forged.status === 401 && db.profiles.get('u-pro').plan === 'free', 'webhook with a bad signature -> 401, plan unchanged');
    const wh = await fetch(`${S}/api/pay/webhook`, { method: 'POST', headers: { 'x-paystack-signature': crypto.createHmac('sha512', PSK).update(evt).digest('hex') }, body: evt });
    check(wh.status === 200 && db.profiles.get('u-pro').plan === 'premium', `signed webhook -> premium until ${db.profiles.get('u-pro').plan_expires_at}`);

    step('premium user: 1080p allowed, file copied to R2 with a signed 24 h link');
    const jp = await job(PRO, 1920);
    check(jp.state === 'done' && /X-Amz-Signature/.test(jp.cloudUrl || ''), `premium job (1920p) done: ${jp.size} bytes, cloud link signed`);
    check(jp.size > jf.size, `premium file is bigger than the capped free one (${jp.size} > ${jf.size})`);
    const cl = await fetch(jp.cloudUrl);
    check(cl.ok && Number(cl.headers.get('content-length')) === jp.size, `signed R2 link downloads the same ${jp.size} bytes`);
    const hist = await (await fetch(`${S}/api/history`, { headers: PRO })).json();
    check(hist.items.length === 1 && /X-Amz-Signature/.test(hist.items[0].cloudUrl || ''), '/api/history lists it with a fresh signed link');

    step('apps keep working (app token, anonymous free)');
    const app = await fetch(`${S}/api/media-info?url=${enc}`, { headers: { 'X-LAS-Token': 'app-token-e2e' } });
    check(app.ok, 'app token analyze -> 200');
    check((await fetch(`${S}/api/media-info?url=${enc}`)).status === 401, 'no token, no login -> 401');
  } finally {
    srv.kill(); mock.close();
    if (process.exitCode) console.log(logs.join('').slice(-3000));
  }
})();
