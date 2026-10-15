// Bachs (second payment option): signature verification, checkout creation, webhook handler (mocked services, fake secrets).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Readable } = require('stream');
const { createSaas, loadConfig, bachsSignatureOk, bachsBaseUrl, decimalToMinor } = require('../server/saas.js');

const SUPA = 'https://proj.supabase.co';
const SECRET = 'whsec_test_not_a_real_secret';
const NOW = Date.parse('2026-10-15T12:00:00Z');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = (payload) => { const d = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`; return `${d}.${b64u(crypto.createHmac('sha256', 'jwt-secret').update(d).digest())}`; };
const auth = { authorization: `Bearer ${token({ sub: 'user-1', email: 'a@b.c', role: 'authenticated', aud: 'authenticated', iss: `${SUPA}/auth/v1`, exp: NOW / 1000 + 3600 })}` };
const sign = (body, ts, secret = SECRET) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
const tsNow = Math.floor(NOW / 1000);
const hdrs = (body, ts = tsNow, secret = SECRET) => ({ 'x-bachs-timestamp': String(ts), 'x-bachs-signature': sign(body, ts, secret) });
const bodyReq = (headers, body) => { const r = Readable.from([Buffer.from(body)]); r.headers = headers; return r; };

function mock({ checkout, checkoutStatus = 200 } = {}) {
  const state = { payments: new Map(), profile: { id: 'user-1', email: 'a@b.c', plan: 'free', plan_expires_at: null }, bachsCalls: [] };
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (u.origin.includes('bachs.io')) {
      state.bachsCalls.push({ method, url: String(url), headers: opts.headers, body });
      assert.match(opts.headers.Authorization, /^Bearer sk_sandbox_test/);
      if (method === 'POST' && u.pathname === '/v1/checkout-sessions') return json(201, { checkout_id: 'chk_abc123', checkout_url: 'https://checkout.bachs.io/c/xyz', status: 'open', reference: body.reference });
      if (u.pathname.startsWith('/v1/checkout-sessions/chk_')) {
        const ref = [...state.payments.keys()][0];
        return json(checkoutStatus, checkout === undefined ? { checkout_id: 'chk_abc123', status: 'completed', amount: '1500.00', currency: 'NGN', reference: ref } : checkout(ref));
      }
    }
    if (u.pathname === '/rest/v1/profiles' && method === 'GET') return json(200, [state.profile]);
    if (u.pathname === '/rest/v1/profiles' && method === 'PATCH') { Object.assign(state.profile, body); return json(204); }
    if (u.pathname === '/rest/v1/payments' && method === 'POST') { state.payments.set(body.reference, { ...body }); return json(201); }
    if (u.pathname === '/rest/v1/payments' && method === 'GET') { const p = state.payments.get(u.searchParams.get('reference').slice(3)); return json(200, p ? [p] : []); }
    if (u.pathname === '/rest/v1/payments' && method === 'PATCH') { const p = state.payments.get(u.searchParams.get('reference').slice(3)); const st = u.searchParams.get('status'); if (!p || (st && st.startsWith('neq.') && p.status === st.slice(4))) return json(200, []); Object.assign(p, body); return json(200, [p]); }
    return json(404, { message: `unmocked ${method} ${u.pathname}` });
  };
  return { state, fetch };
}
function cfg(over = {}) {
  process.env.SUPABASE_URL = SUPA; const c = loadConfig(); delete process.env.SUPABASE_URL;
  return { ...c, serviceKey: 'service-key', jwtSecret: 'jwt-secret', paystackSecret: 'sk_test_123', bachsEnabled: true, bachsKey: 'sk_sandbox_test_key', bachsWebhookSecret: SECRET, bachsBase: 'https://sandbox-api.bachs.io', ...over };
}
async function started(m, over) {
  const s = createSaas({ config: cfg(over), fetch: m.fetch, now: () => NOW, storage: null });
  const init = await s.routes['POST /api/pay/bachs/initialize'](bodyReq(auth, '{"plan":"monthly"}'));
  return { s, init };
}
const hook = (s, evt, headers) => { const b = JSON.stringify(evt); return s.routes['POST /api/pay/bachs/webhook'](bodyReq(headers || hdrs(b), b)); };
const evtSucceeded = (ref, o = {}) => ({ id: 'evt_1', type: 'collection.succeeded', created_at: '2026-10-15T12:00:00Z', data: { charge_id: 'ch_1', checkout_id: 'chk_abc123', reference: ref, status: 'SUCCEEDED', amount: '1500.00', currency: 'NGN', metadata: { user_id: 'user-1' }, ...o } });

test('signature: valid, tampered body, wrong secret, stale, future, V2 header with rotation', () => {
  const body = '{"id":"evt_1"}';
  assert.ok(bachsSignatureOk(SECRET, body, hdrs(body), NOW));
  assert.ok(bachsSignatureOk(SECRET, Buffer.from(body), hdrs(body), NOW));
  assert.ok(!bachsSignatureOk(SECRET, body + ' ', hdrs(body), NOW));
  assert.ok(!bachsSignatureOk(SECRET, body, hdrs(body, tsNow, 'other'), NOW));
  assert.ok(!bachsSignatureOk(SECRET, body, hdrs(body, tsNow - 301), NOW), 'older than 5 min');
  assert.ok(!bachsSignatureOk(SECRET, body, hdrs(body, tsNow + 301), NOW), 'too far in the future');
  assert.ok(bachsSignatureOk(SECRET, body, hdrs(body, tsNow - 299), NOW));
  assert.ok(!bachsSignatureOk('', body, hdrs(body), NOW));
  assert.ok(!bachsSignatureOk(SECRET, body, {}, NOW));
  assert.ok(!bachsSignatureOk(SECRET, body, { 'x-bachs-timestamp': 'abc', 'x-bachs-signature': 'x' }, NOW));
  assert.ok(!bachsSignatureOk(SECRET, body, { 'x-bachs-timestamp': String(tsNow), 'x-bachs-signature': 'short' }, NOW));
  const v2 = (sigs) => ({ 'x-bachs-signature-v2': `t=${tsNow},${sigs.map((s) => `v1=${s}`).join(',')}` });
  assert.ok(bachsSignatureOk(SECRET, body, v2([sign(body, tsNow)]), NOW));
  assert.ok(bachsSignatureOk(SECRET, body, v2(['deadbeef', sign(body, tsNow)]), NOW), 'any v1 may match (rotation)');
  assert.ok(!bachsSignatureOk(SECRET, body, v2(['deadbeef']), NOW));
});

test('base URL derives from key prefix / BACHS_ENV / override; defaults to sandbox', () => {
  assert.strictEqual(bachsBaseUrl('sk_sandbox_x'), 'https://sandbox-api.bachs.io');
  assert.strictEqual(bachsBaseUrl('sk_live_x'), 'https://api.bachs.io');
  assert.strictEqual(bachsBaseUrl('sk_live_x', 'sandbox'), 'https://sandbox-api.bachs.io');
  assert.strictEqual(bachsBaseUrl('sk_sandbox_x', 'live'), 'https://api.bachs.io');
  assert.strictEqual(bachsBaseUrl('', ''), 'https://sandbox-api.bachs.io');
  assert.strictEqual(bachsBaseUrl('sk_live_x', '', 'http://localhost:9/'), 'http://localhost:9');
});

test('decimalToMinor', () => {
  assert.strictEqual(decimalToMinor('1500.00'), 150000);
  assert.strictEqual(decimalToMinor('1500'), 150000);
  assert.strictEqual(decimalToMinor('12000.5'), 1200050);
  assert.strictEqual(decimalToMinor('1499.999'), null);
  assert.strictEqual(decimalToMinor('abc'), null);
  assert.strictEqual(decimalToMinor(undefined), null);
});

test('feature flag: off by default, initialize refused, /api/pay/options reflects it', async () => {
  const m = mock();
  const off = createSaas({ config: cfg({ bachsEnabled: false }), fetch: m.fetch, now: () => NOW, storage: null });
  assert.deepStrictEqual(await off.routes['GET /api/pay/options'](), { success: true, paystack: true, bachs: false });
  await assert.rejects(off.routes['POST /api/pay/bachs/initialize'](bodyReq(auth, '{"plan":"monthly"}')), (e) => e.status === 503);
  assert.strictEqual(m.state.bachsCalls.length, 0);
  const noKey = createSaas({ config: cfg({ bachsKey: '' }), fetch: m.fetch, now: () => NOW, storage: null });
  assert.strictEqual((await noKey.routes['GET /api/pay/options']()).bachs, false);
  const on = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  assert.strictEqual((await on.routes['GET /api/pay/options']()).bachs, true);
  delete process.env.BACHS_ENABLED; assert.strictEqual(loadConfig().bachsEnabled, false);
});

test('initialize: product-less NGN pricing, metadata, URLs, idempotency key; row saved pending', async () => {
  const m = mock();
  const { init } = await started(m);
  assert.strictEqual(init.checkoutUrl, 'https://checkout.bachs.io/c/xyz');
  const c = m.state.bachsCalls[0];
  assert.strictEqual(c.url, 'https://sandbox-api.bachs.io/v1/checkout-sessions');
  assert.deepStrictEqual(c.body.pricing, { currency: 'NGN', amount: '1500.00' });
  assert.strictEqual(c.body.reference, init.reference);
  assert.match(init.reference, /^las_bachs_monthly_[a-f0-9]{20}$/);
  assert.deepStrictEqual(c.body.metadata, { user_id: 'user-1', plan_interval: 'monthly', reference: init.reference, app: 'las-converter' });
  assert.strictEqual(c.body.success_url, 'https://lasconverter.lasgconcept.com/account');
  assert.strictEqual(c.body.cancel_url, 'https://lasconverter.lasgconcept.com/account');
  assert.strictEqual(c.headers['Idempotency-Key'], init.reference);
  assert.deepStrictEqual(c.body.customer, { email: 'a@b.c' });
  const row = m.state.payments.get(init.reference);
  assert.deepStrictEqual([row.amount, row.currency, row.status, row.plan_interval], [150000, 'NGN', 'pending', 'monthly']);
  const y = await createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null }).routes['POST /api/pay/bachs/initialize'](bodyReq(auth, '{"plan":"yearly"}'));
  assert.strictEqual(m.state.bachsCalls[1].body.pricing.amount, '12000.00');
  assert.ok(y.reference.startsWith('las_bachs_yearly_'));
});

test('webhook: bad/missing signature rejected with 400, nothing granted', async () => {
  const m = mock(); const { s, init } = await started(m);
  const evt = evtSucceeded(init.reference); const b = JSON.stringify(evt);
  await assert.rejects(hook(s, evt, { 'x-bachs-timestamp': String(tsNow), 'x-bachs-signature': 'bad' }), (e) => e.status === 400 && e.code === 'bad_signature');
  await assert.rejects(hook(s, evt, {}), (e) => e.status === 400);
  await assert.rejects(hook(s, evt, hdrs(b, tsNow - 1000)), (e) => e.status === 400, 'replay of an old delivery');
  assert.strictEqual(m.state.profile.plan, 'free');
});

test('webhook: collection.succeeded grants 30 days once; checkout.completed afterwards is a duplicate', async () => {
  const m = mock(); const { s, init } = await started(m);
  const r = await hook(s, evtSucceeded(init.reference));
  assert.strictEqual(r.plan, 'premium');
  assert.strictEqual(m.state.profile.plan, 'premium');
  assert.strictEqual(m.state.profile.plan_expires_at, new Date(NOW + 30 * 86400e3).toISOString());
  assert.strictEqual(m.state.payments.get(init.reference).status, 'success');
  assert.ok((await hook(s, evtSucceeded(init.reference))).duplicate, 'same event twice');
  const cc = { id: 'evt_2', type: 'checkout.completed', data: { checkout_id: 'chk_abc123', reference: init.reference, payment_status: 'paid', amount: '1500.00', currency: 'NGN', metadata: { user_id: 'user-1' } } };
  assert.ok((await hook(s, cc)).duplicate, 'other event type');
  assert.strictEqual(m.state.profile.plan_expires_at, new Date(NOW + 30 * 86400e3).toISOString(), 'no double extension');
});

test('webhook: checkout.completed first works too; yearly adds 365 days on top of remaining time', async () => {
  const m = mock(); m.state.profile = { id: 'user-1', email: 'a@b.c', plan: 'premium', plan_expires_at: new Date(NOW + 10 * 86400e3).toISOString() };
  const s = createSaas({ config: cfg(), fetch: m.fetch, now: () => NOW, storage: null });
  const init = await s.routes['POST /api/pay/bachs/initialize'](bodyReq(auth, '{"plan":"yearly"}'));
  m.fetch.checkoutAmount = '12000.00';
  const m2 = m; // checkout mock reads reference from the stored payment
  const origFetch = m2.fetch;
  const s2 = createSaas({ config: cfg(), fetch: async (u, o) => { if (String(u).includes('/v1/checkout-sessions/chk_')) return { ok: true, status: 200, json: async () => ({ status: 'completed', amount: '12000.00', currency: 'NGN', reference: init.reference }) }; return origFetch(u, o); }, now: () => NOW, storage: null });
  const cc = { id: 'evt_2', type: 'checkout.completed', data: { checkout_id: 'chk_abc123', reference: init.reference, payment_status: 'paid', amount: '12000.00', currency: 'NGN' } };
  const r = await hook(s2, cc);
  assert.strictEqual(r.plan, 'premium');
  assert.strictEqual(m.state.profile.plan_expires_at, new Date(NOW + (10 + 365) * 86400e3).toISOString());
});

test('webhook: amount below the plan price, or wrong currency, is held (no grant)', async () => {
  for (const co of [{ amount: '1000.00', currency: 'NGN' }, { amount: '1500.00', currency: 'USD' }, { amount: 'abc', currency: 'NGN' }]) {
    const m = mock({ checkout: (ref) => ({ status: 'completed', reference: ref, ...co }) });
    const { s, init } = await started(m);
    const r = await hook(s, evtSucceeded(init.reference));
    assert.strictEqual(r.ignored, 'amount_mismatch');
    assert.strictEqual(m.state.profile.plan, 'free');
    assert.strictEqual(m.state.payments.get(init.reference).status, 'pending');
    assert.strictEqual(m.state.payments.get(init.reference).raw.held_for_review, true);
  }
});

test('webhook: overpaid is accepted; ACCEPTED/other states need manual review', async () => {
  const m = mock(); const { s, init } = await started(m);
  assert.strictEqual((await hook(s, evtSucceeded(init.reference, { status: 'ACCEPTED' }))).ignored, 'needs_review');
  assert.strictEqual(m.state.profile.plan, 'free');
  assert.strictEqual((await hook(s, evtSucceeded(init.reference, { status: 'OVERPAID' }))).plan, 'premium');
});

test('webhook: checkout not completed or Bachs lookup failing -> 5xx so Bachs retries; nothing granted', async () => {
  let m = mock({ checkout: (ref) => ({ status: 'open', reference: ref, amount: '1500.00', currency: 'NGN' }) });
  let { s, init } = await started(m);
  await assert.rejects(hook(s, evtSucceeded(init.reference)), (e) => e.status === 503);
  m = mock({ checkoutStatus: 500, checkout: () => ({ detail: 'x' }) });
  ({ s, init } = await started(m));
  await assert.rejects(hook(s, evtSucceeded(init.reference)), (e) => e.status === 503);
  assert.strictEqual(m.state.profile.plan, 'free');
  assert.strictEqual(m.state.payments.get(init.reference).status, 'pending');
});

test('webhook: failed / underpaid / expired never grant and never mark failed; they leave a note', async () => {
  const m = mock(); const { s, init } = await started(m);
  for (const [type, data] of [['collection.failed', { status: 'FAILED', reason: 'declined' }], ['collection.underpaid', { status: 'UNDERPAID', amount_paid: '500.00', amount_expected: '1500.00' }], ['checkout.expired', {}]]) {
    const r = await hook(s, { id: `evt_${type}`, type, data: { checkout_id: 'chk_abc123', reference: init.reference, ...data } });
    assert.strictEqual(r.noted, type);
    assert.strictEqual(m.state.payments.get(init.reference).status, 'pending');
    assert.strictEqual(m.state.payments.get(init.reference).raw.last_event, type);
  }
  assert.strictEqual(m.state.profile.plan, 'free');
  // ...and a late successful payment still completes the order afterwards
  assert.strictEqual((await hook(s, evtSucceeded(init.reference))).plan, 'premium');
});

test('webhook: unknown reference, foreign checkout id, other user id, unrelated events are ignored with 200', async () => {
  const m = mock(); const { s, init } = await started(m);
  assert.strictEqual((await hook(s, evtSucceeded('las_bachs_monthly_ffffffffffffffffffff'))).ignored, 'unknown_reference');
  assert.strictEqual((await hook(s, evtSucceeded('las_monthly_paystackref0001'))).ignored, 'unknown_reference');
  assert.strictEqual((await hook(s, evtSucceeded(init.reference, { checkout_id: 'chk_other' }))).ignored, 'checkout_mismatch');
  assert.strictEqual((await hook(s, evtSucceeded(init.reference, { metadata: { user_id: 'user-2' } }))).ignored, 'user_mismatch');
  assert.strictEqual((await hook(s, { id: 'e', type: 'payout.paid', data: {} })).ignored, 'payout.paid');
  assert.strictEqual((await hook(s, { id: 'e', type: 'checkout.completed', data: { checkout_id: 'chk_abc123', reference: init.reference, payment_status: 'no_payment_required' } })).ignored, 'no_payment');
  assert.strictEqual(m.state.profile.plan, 'free');
});

test('Paystack paths cannot be used on a Bachs reference', async () => {
  const m = mock(); const { s, init } = await started(m);
  await assert.rejects(s.routes['POST /api/pay/verify'](bodyReq(auth, JSON.stringify({ reference: init.reference }))), (e) => e.status === 400);
});
