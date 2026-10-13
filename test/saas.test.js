// SaaS layer: Supabase JWT verification, plan gating, quotas, Paystack webhook (mocked services).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createSaas, paystackSignatureOk } = require('../server/saas.js');

const SUPA = 'https://proj.supabase.co';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function hsToken(secret, payload, header = { alg: 'HS256', typ: 'JWT' }) {
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(crypto.createHmac('sha256', secret).update(data).digest())}`;
}
const { privateKey: ecPriv, publicKey: ecPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
function esToken(payload, kid = 'k1') {
  const data = `${b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(crypto.sign('sha256', Buffer.from(data), { key: ecPriv, dsaEncoding: 'ieee-p1363' }))}`;
}
const NOW = Date.parse('2026-10-13T12:00:00Z');
const claims = (o = {}) => ({ sub: 'user-1', email: 'a@b.c', role: 'authenticated', aud: 'authenticated', iss: `${SUPA}/auth/v1`, exp: NOW / 1000 + 3600, ...o });

/** In-memory Supabase (PostgREST + JWKS) and Paystack. */
function mockServices({ profile = { id: 'user-1', email: 'a@b.c', plan: 'free', plan_expires_at: null }, tx = null } = {}) {
  const state = { usage: 0, downloads: [], payments: new Map(), profile: { ...profile }, calls: [] };
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push(`${method} ${u.pathname}`);
    if (u.pathname === '/auth/v1/.well-known/jwks.json') return json(200, { keys: [{ ...ecPub.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' }] });
    if (u.origin === SUPA) assert.strictEqual(opts.headers.apikey, 'service-key');
    if (u.pathname === '/rest/v1/profiles' && method === 'GET') return json(200, u.searchParams.get('id') === `eq.${state.profile.id}` ? [state.profile] : []);
    if (u.pathname === '/rest/v1/profiles' && method === 'PATCH') { Object.assign(state.profile, body); return json(204); }
    if (u.pathname === '/rest/v1/rpc/consume_download') { if (state.usage < body.p_limit) { state.usage++; return json(200, [{ allowed: true, used: state.usage }]); } return json(200, [{ allowed: false, used: state.usage }]); }
    if (u.pathname === '/rest/v1/rpc/usage_today') return json(200, state.usage);
    if (u.pathname === '/rest/v1/downloads' && method === 'POST') { state.downloads.push(body); return json(201); }
    if (u.pathname === '/rest/v1/payments' && method === 'POST') { state.payments.set(body.reference, { ...body }); return json(201); }
    if (u.pathname === '/rest/v1/payments' && method === 'GET') { const p = state.payments.get(u.searchParams.get('reference').slice(3)); return json(200, p ? [p] : []); }
    if (u.pathname === '/rest/v1/payments' && method === 'PATCH') { const p = state.payments.get(u.searchParams.get('reference').slice(3)); const st = u.searchParams.get('status'); if (!p || (st && st.startsWith('neq.') && p.status === st.slice(4))) return json(200, []); Object.assign(p, body); return json(200, [p]); }
    if (u.pathname === '/transaction/initialize') { assert.match(opts.headers.Authorization, /^Bearer sk_test_/); return json(200, { status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: body.reference } }); }
    if (u.pathname.startsWith('/transaction/verify/')) return json(200, { status: true, data: tx || { status: 'success', amount: 150000, currency: 'NGN' } });
    return json(404, { message: `unmocked ${method} ${u.pathname}` });
  };
  return { state, fetch };
}
function cfg(over = {}) {
  process.env.SUPABASE_URL = SUPA;
  const { loadConfig } = require('../server/saas.js');
  const c = loadConfig();
  delete process.env.SUPABASE_URL;
  return { ...c, serviceKey: 'service-key', jwtSecret: 'jwt-secret', paystackSecret: 'sk_test_123', paystackBase: 'https://api.paystack.co', ...over };
}
const req = (headers = {}) => ({ headers });

test('saas is disabled without SUPABASE_URL (current site keeps working)', () => {
  delete process.env.SUPABASE_URL;
  assert.strictEqual(createSaas().enabled, false);
});

test('JWT: valid HS256 and ES256 (JWKS) tokens are accepted', async () => {
  const m = mockServices();
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const a = await s.identify(req({ authorization: `Bearer ${hsToken('jwt-secret', claims())}` }));
  assert.strictEqual(a.user.id, 'user-1'); assert.strictEqual(a.plan.key, 'free');
  const b = await s.identify(req({ authorization: `Bearer ${esToken(claims())}` }));
  assert.strictEqual(b.user.email, 'a@b.c');
});

test('JWT: forged, expired, wrong issuer and anon tokens are rejected', async () => {
  const m = mockServices();
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const bad = async (t, code) => assert.rejects(s.identify(req({ authorization: `Bearer ${t}` })), (e) => e.status === 401 && (!code || e.code === code));
  await bad(hsToken('wrong-secret', claims()));
  await bad(hsToken('jwt-secret', claims({ exp: NOW / 1000 - 600 })), 'token_expired');
  await bad(hsToken('jwt-secret', claims({ iss: 'https://evil.supabase.co/auth/v1' })));
  await bad(hsToken('jwt-secret', claims({ role: 'anon', sub: undefined })));
  await bad(hsToken('jwt-secret', claims(), { alg: 'none' }));
  await bad(esToken(claims(), 'unknown-kid'));
  const t = hsToken('jwt-secret', claims()); await bad(t.slice(0, -3) + 'AAA');
  await bad('not-a-jwt');
});

test('anonymous callers are free; LAS_REQUIRE_LOGIN rejects them', async () => {
  const m = mockServices();
  assert.strictEqual((await createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null }).identify(req())).plan.key, 'free');
  await assert.rejects(createSaas({ config: cfg({ requireLogin: true }), fetch: m.fetch, now: () => NOW, storage: null }).identify(req()), (e) => e.code === 'login_required');
});

test('plan gating: free MP3 is limited to 192k; premium is not (video is capped in yt-dlp)', async () => {
  const m = mockServices();
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const who = await s.identify(req({ authorization: `Bearer ${hsToken('jwt-secret', claims())}` }));
  assert.doesNotThrow(() => s.checkRequest(who, { format: 'mp4', quality: 720, bitrate: 192 }));
  assert.doesNotThrow(() => s.checkRequest(who, { format: 'mp4', quality: 1080, bitrate: 192 }));
  assert.throws(() => s.checkRequest(who, { format: 'mp4', quality: 99999, bitrate: 192 }), (e) => e.status === 400);
  assert.throws(() => s.checkRequest(who, { format: 'mp3', quality: 720, bitrate: 320 }), (e) => e.code === 'premium_required');
  m.state.profile.plan = 'premium'; m.state.profile.plan_expires_at = '2026-11-01T00:00:00Z';
  const prem = await s.identify(req({ authorization: `Bearer ${hsToken('jwt-secret', claims())}` }));
  assert.strictEqual(prem.plan.key, 'premium');
  assert.doesNotThrow(() => s.checkRequest(prem, { format: 'mp4', quality: 2160, bitrate: 320 }));
  m.state.profile.plan_expires_at = '2026-10-01T00:00:00Z'; // expired premium -> free
  assert.strictEqual((await s.identify(req({ authorization: `Bearer ${hsToken('jwt-secret', claims())}` }))).plan.key, 'free');
});

test('quota: 10 downloads a day for free users (server-side), then 429', async () => {
  const m = mockServices();
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const who = await s.identify(req({ authorization: `Bearer ${hsToken('jwt-secret', claims())}` }));
  for (let i = 1; i <= 10; i++) assert.strictEqual(await s.consume(who, '1.2.3.4'), i);
  await assert.rejects(s.consume(who, '1.2.3.4'), (e) => e.status === 429 && e.code === 'quota_exceeded' && /Upgrade/.test(e.message));
  // anonymous callers are counted per IP
  const anon = await s.identify(req());
  for (let i = 0; i < 10; i++) await s.consume(anon, '5.6.7.8');
  await assert.rejects(s.consume(anon, '5.6.7.8'), (e) => e.code === 'quota_exceeded');
  assert.strictEqual(await s.consume(anon, '9.9.9.9'), 1);
});

test('Paystack signature check (HMAC-SHA512 of the raw body)', () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const sig = crypto.createHmac('sha512', 'sk_test_123').update(body).digest('hex');
  assert.ok(paystackSignatureOk('sk_test_123', body, sig));
  assert.ok(!paystackSignatureOk('sk_test_123', Buffer.from('{"event":"charge.success "}'), sig));
  assert.ok(!paystackSignatureOk('sk_test_123', body, sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a')));
  assert.ok(!paystackSignatureOk('sk_test_123', body, undefined));
  assert.ok(!paystackSignatureOk('', body, sig));
});

/** Fake request stream for the routes. */
function bodyReq(headers, body) {
  const { Readable } = require('stream');
  const r = Readable.from([Buffer.from(body)]); r.headers = headers; return r;
}

test('payments: initialize, then a signed webhook grants premium once (idempotent)', async () => {
  const m = mockServices();
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const auth = { authorization: `Bearer ${hsToken('jwt-secret', claims())}` };
  const init = await s.routes['POST /api/pay/initialize'](bodyReq(auth, '{"plan":"monthly"}'));
  assert.strictEqual(init.authorizationUrl, 'https://checkout.paystack.com/abc');
  assert.strictEqual(m.state.payments.get(init.reference).amount, 150000);
  const evt = JSON.stringify({ event: 'charge.success', data: { reference: init.reference, amount: 150000, currency: 'NGN' } });
  const sig = crypto.createHmac('sha512', 'sk_test_123').update(evt).digest('hex');
  await assert.rejects(s.routes['POST /api/pay/webhook'](bodyReq({ 'x-paystack-signature': 'bad' }, evt)), (e) => e.status === 401);
  assert.strictEqual(m.state.profile.plan, 'free');
  const r = await s.routes['POST /api/pay/webhook'](bodyReq({ 'x-paystack-signature': sig }, evt));
  assert.strictEqual(r.plan, 'premium');
  assert.strictEqual(m.state.profile.plan, 'premium');
  assert.strictEqual(m.state.profile.plan_expires_at, new Date(NOW + 30 * 86400e3).toISOString());
  const again = await s.routes['POST /api/pay/webhook'](bodyReq({ 'x-paystack-signature': sig }, evt));
  assert.ok(again.duplicate);
  assert.strictEqual(m.state.profile.plan_expires_at, new Date(NOW + 30 * 86400e3).toISOString());
});

test('payments: an underpaid transaction (verify API) does not grant premium', async () => {
  const m = mockServices({ tx: { status: 'success', amount: 100, currency: 'NGN' } });
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const init = await s.routes['POST /api/pay/initialize'](bodyReq({ authorization: `Bearer ${hsToken('jwt-secret', claims())}` }, '{"plan":"yearly"}'));
  const evt = JSON.stringify({ event: 'charge.success', data: { reference: init.reference } });
  const r = await s.routes['POST /api/pay/webhook'](bodyReq({ 'x-paystack-signature': crypto.createHmac('sha512', 'sk_test_123').update(evt).digest('hex') }, evt));
  assert.strictEqual(r.ignored, 'verification_failed');
  assert.strictEqual(m.state.profile.plan, 'free');
  assert.strictEqual(m.state.payments.get(init.reference).status, 'failed');
});

test('premium jobs get a cloud copy (R2) and a history row; free jobs only history', async () => {
  const m = mockServices({ profile: { id: 'user-1', email: 'a@b.c', plan: 'premium', plan_expires_at: '2027-01-01T00:00:00Z' } });
  const puts = [];
  const storage = { put: async (key, stream, size) => { await new Promise((r) => stream.on('close', r).resume()); puts.push({ key, size }); }, signedUrl: async (key) => `https://r2.example/${key}?sig=1` };
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage });
  const who = await s.identify(req({ authorization: `Bearer ${hsToken('jwt-secret', claims())}` }));
  const fs = require('fs'); const f = require('path').join(require('os').tmpdir(), `las-saas-${process.pid}.mp4`); fs.writeFileSync(f, 'x'.repeat(10));
  const c = await s.afterJob(who, { id: 'job1' }, { file: f, size: 10, name: 'v.mp4', mime: 'video/mp4', url: 'https://fb/x', format: 'mp4', quality: 1080, fsMod: fs });
  fs.rmSync(f);
  assert.strictEqual(puts[0].key, 'u/user-1/job1/v.mp4');
  assert.match(c.cloudUrl, /^https:\/\/r2\.example\//);
  assert.strictEqual(m.state.downloads[0].r2_key, 'u/user-1/job1/v.mp4');
  assert.strictEqual(m.state.downloads[0].expires_at, new Date(NOW + 24 * 3600e3).toISOString());
});

test('free plan video cap uses the short side (reels 720x1280 count as 720p)', () => {
  const { formatArgs } = require('../server/ytdlp.js');
  const f = formatArgs('video', 1920, 192, '', 720);
  const sel = f[f.indexOf('-f') + 1];
  assert.match(sel, /^bv\*\[height<=1920\]\[height<=\?720\]\+ba\/bv\*\[height<=1920\]\[width<=\?720\]\+ba/);
  assert.ok(!/\/b$|\/w$/.test(sel), 'no uncapped fallback');
  assert.strictEqual(formatArgs('video', 720, 192, '')[1], 'bv*[height<=720]+ba/b[height<=720]/b'); // apps / premium: unchanged
});

test('single device: newest login wins; older session gets 401 signed_in_elsewhere', async () => {
  const m = mockServices();
  m.state.claimable = new Set(['sess-A', 'sess-B']);
  const base = m.fetch;
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/rest/v1/rpc/claim_session') {
      const b = JSON.parse(opts.body);
      if (!m.state.claimable.has(b.p_session)) return { ok: true, status: 200, json: async () => false, text: async () => 'false' };
      m.state.profile.active_session_id = b.p_session; m.state.claimable = new Set([b.p_session]);
      return { ok: true, status: 200, json: async () => true, text: async () => 'true' };
    }
    return base(url, opts);
  };
  const s = createSaas({ config: cfg(), fetch, now: () => NOW, storage: null });
  const tA = esToken(claims({ session_id: 'sess-A' })); const tB = esToken(claims({ session_id: 'sess-B' }));
  const call = (route, t) => s.routes[route](bodyReq({ authorization: `Bearer ${t}` }, ''));
  // before any claim (existing users / old tokens): allowed
  assert.strictEqual((await call('GET /api/me', tA)).user.id, 'user-1');
  assert.strictEqual((await call('POST /api/session/claim', tA)).sessionId, 'sess-A');
  assert.strictEqual((await call('GET /api/me', tA)).success, true);
  m.state.claimable.add('sess-B'); // device B logs in (new session)
  await call('POST /api/session/claim', tB);
  await assert.rejects(call('GET /api/me', tA), (e) => e.status === 401 && e.code === 'signed_in_elsewhere');
  await assert.rejects(s.userId(req({ authorization: `Bearer ${tA}` })), (e) => e.code === 'signed_in_elsewhere');
  assert.strictEqual((await call('GET /api/me', tB)).success, true);
  // A's session was revoked: it cannot take the account back
  await assert.rejects(call('POST /api/session/claim', tA), (e) => e.code === 'signed_in_elsewhere');
  assert.strictEqual(m.state.profile.active_session_id, 'sess-B');
  // app-token / anonymous callers are unaffected
  assert.strictEqual((await s.identify(req())).user, null);
});

test('cloud transcription: off without GROQ_API_KEY, premium only, forwards to Groq and drops no-speech segments', async () => {
  const { Readable } = require('stream');
  const m = mockServices();
  let groqCall = null;
  const fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.groq.com/')) {
      groqCall = { url: String(url), auth: opts.headers.Authorization, model: opts.body.get('model'), lang: opts.body.get('language'), size: opts.body.get('file').size };
      return { ok: true, status: 200, json: async () => ({ language: 'english', duration: 12, segments: [
        { start: 0, end: 4, text: ' Hello there.', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 },
        { start: 5, end: 9, text: ' Thank you for watching.', no_speech_prob: 0.9, avg_logprob: -1.2, compression_ratio: 1.0 }] }) };
    }
    return m.fetch(url, opts);
  };
  const body = () => Object.assign(Readable.from([Buffer.alloc(4000, 1)]), { url: '/api/transcribe?lang=en', headers: { authorization: `Bearer ${hsToken('jwt-secret', claims())}`, 'content-type': 'audio/wav' } });
  const off = createSaas({ config: cfg({ groqKey: '' }), fetch, now: () => NOW, storage: null });
  assert.strictEqual((await off.routes['GET /api/transcribe/status'](req())).enabled, false);
  await assert.rejects(off.routes['POST /api/transcribe'](body()), (e) => e.code === 'stt_off');
  const s = createSaas({ config: cfg({ groqKey: 'gsk_test', groqModel: 'whisper-large-v3-turbo', groqBase: 'https://api.groq.com/openai/v1' }), fetch, now: () => NOW, storage: null });
  assert.strictEqual((await s.routes['GET /api/transcribe/status'](req())).enabled, true);
  await assert.rejects(s.routes['POST /api/transcribe'](body()), (e) => e.code === 'premium_required');
  m.state.profile.plan = 'premium'; m.state.profile.plan_expires_at = '2026-11-01T00:00:00Z';
  const r = await s.routes['POST /api/transcribe'](body());
  assert.deepStrictEqual(r.segments, [{ start: 0, end: 4, text: 'Hello there.' }]);
  assert.strictEqual(groqCall.auth, 'Bearer gsk_test'); assert.strictEqual(groqCall.lang, 'en'); assert.strictEqual(groqCall.size, 4000);
  assert.strictEqual(groqCall.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
});

test('desktop local downloads: login required, plan caps, shared daily quota', async () => {
  const m = mockServices();
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const t = esToken(claims());
  const call = (body, h = { authorization: `Bearer ${t}` }) => s.routes['POST /api/local-download'](bodyReq(h, JSON.stringify(body)));
  await assert.rejects(call({ format: 'mp4', quality: 720 }, {}), (e) => e.status === 401 && e.code === 'login_required');
  await assert.rejects(call({ format: 'mp4', quality: 1080 }), (e) => e.status === 402 && e.code === 'premium_required');
  await assert.rejects(call({ format: 'mp3', bitrate: 320 }), (e) => e.status === 402);
  const r = await call({ format: 'mp4', quality: 720 });
  assert.strictEqual(r.used, 1); assert.strictEqual(r.maxHeight, 720); assert.strictEqual(r.limit, 10);
  for (let i = 1; i < 10; i++) await call({ format: 'mp3', bitrate: 192 });
  await assert.rejects(call({ format: 'mp4', quality: 480 }), (e) => e.status === 429 && e.code === 'quota_exceeded');
  m.state.profile.plan = 'premium'; m.state.profile.plan_expires_at = new Date(NOW + 86400e3).toISOString(); m.state.usage = 0;
  assert.strictEqual((await call({ format: 'mp4', quality: 2160 })).maxHeight, 2160);
});

test('cloud translation: Yoruba -> English via large-v3 transcription + LLM, keeps source segments', async () => {
  const { Readable } = require('stream');
  const m = mockServices();
  m.state.profile.plan = 'premium'; m.state.profile.plan_expires_at = '2026-11-01T00:00:00Z';
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/audio/transcriptions')) {
      calls.push({ u, model: opts.body.get('model'), lang: opts.body.get('language') });
      return { ok: true, status: 200, json: async () => ({ segments: [{ start: 0, end: 3, text: ' E kaaro', no_speech_prob: 0.01, avg_logprob: -0.3, compression_ratio: 1 }, { start: 3, end: 6, text: ' Bawo ni', no_speech_prob: 0.01, avg_logprob: -0.3, compression_ratio: 1 }] }) };
    }
    if (u.endsWith('/chat/completions')) {
      const b = JSON.parse(opts.body); calls.push({ u, model: b.model });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ t: ['Good morning', 'How are you'] }) } }] }) };
    }
    return m.fetch(url, opts);
  };
  const s = createSaas({ config: cfg({ groqKey: 'gsk_test', groqBase: 'https://api.groq.com/openai/v1' }), fetch, now: () => NOW, storage: null });
  const body = Object.assign(Readable.from([Buffer.alloc(4000, 1)]), { url: '/api/transcribe?lang=yo&target=en', headers: { authorization: `Bearer ${hsToken('jwt-secret', claims())}`, 'content-type': 'audio/wav' } });
  const r = await s.routes['POST /api/transcribe'](body);
  assert.deepStrictEqual(r.segments.map((x) => x.text), ['Good morning', 'How are you']);
  assert.deepStrictEqual(r.sourceSegments.map((x) => x.text), ['E kaaro', 'Bawo ni']);
  assert.strictEqual(r.segments[1].start, 3);
  assert.strictEqual(calls[0].model, 'whisper-large-v3'); assert.strictEqual(calls[0].lang, 'yo');
  assert.ok(calls[1].u.endsWith('/chat/completions'));
});
