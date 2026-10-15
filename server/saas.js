'use strict';
/**
 * LAS Converter SaaS layer for the public server: Supabase auth (JWT), plans
 * and quotas (Supabase tables), Cloudflare R2 cloud copies (S3 API, signed
 * links) and Paystack (+ optional Bachs, flag BACHS_ENABLED) payments (initialize + signed webhook).
 *
 * Everything is off unless SUPABASE_URL is set, so the current public site
 * and the apps keep working until the switch. No dependency is loaded in that
 * case (@aws-sdk is only required when R2 is configured).
 *
 * External calls go through `deps.fetch` / `deps.storage` / `deps.now` so the
 * tests can run with mocked Supabase, R2 and Paystack.
 */
const crypto = require('crypto');

// ------------------------------------------------------------------ config
function env(name, def = '') { const v = process.env[name]; return v === undefined || v === '' ? def : v; }
function int(name, def) { const v = parseInt(env(name, ''), 10); return Number.isFinite(v) ? v : def; }

function loadConfig() {
  const supabaseUrl = env('SUPABASE_URL').replace(/\/+$/, '');
  const defaults = {
    free: { name: 'Free', dailyDownloads: 10, maxHeight: 720, maxBitrate: 192, maxVideoSec: 20 * 60, maxAudioSec: 2 * 3600, priority: 0, cloud: false, batch: false, ads: true },
    premium: { name: 'Premium', dailyDownloads: 200, maxHeight: 2160, maxBitrate: 320, maxVideoSec: 3 * 3600, maxAudioSec: 6 * 3600, priority: 10, cloud: true, batch: true, ads: false },
  };
  let plans = defaults;
  if (env('LAS_PLANS_JSON')) {
    const o = JSON.parse(env('LAS_PLANS_JSON'));
    plans = { free: { ...defaults.free, ...(o.free || {}) }, premium: { ...defaults.premium, ...(o.premium || {}) } };
  }
  return {
    enabled: !!supabaseUrl,
    supabaseUrl,
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    jwtSecret: env('SUPABASE_JWT_SECRET'), // legacy HS256 projects; new projects use JWKS (RS256/ES256)
    requireLogin: env('LAS_REQUIRE_LOGIN') === '1',
    // Cloud speech-to-text (Groq Whisper). Off until GROQ_API_KEY is set; Premium only.
    groqKey: env('GROQ_API_KEY'),
    groqModel: env('GROQ_STT_MODEL', 'whisper-large-v3-turbo'),
    groqBase: env('GROQ_API_BASE', 'https://api.groq.com/openai/v1'),
    // Speech -> English (/audio/translations) needs whisper-large-v3 (turbo has no translate task);
    // large-v3 is also used to transcribe low-resource languages (Yoruba, Hausa, Igbo...).
    groqLargeModel: env('GROQ_STT_LARGE_MODEL', 'whisper-large-v3'),
    groqLlmModel: env('GROQ_LLM_MODEL', 'openai/gpt-oss-120b'),
    plans,
    prices: { // amounts in kobo (NGN x 100)
      monthly: { amount: int('LAS_PRICE_MONTHLY_KOBO', 150000), days: 30 },
      yearly: { amount: int('LAS_PRICE_YEARLY_KOBO', 1200000), days: 365 },
    },
    currency: env('LAS_CURRENCY', 'NGN'),
    paystackSecret: env('PAYSTACK_SECRET_KEY'),
    paystackBase: env('PAYSTACK_API_BASE', 'https://api.paystack.co').replace(/\/+$/, ''),
    payCallbackUrl: env('LAS_PAY_CALLBACK_URL'),
    // Bachs (second payment option). Hidden/disabled unless BACHS_ENABLED=1 and BACHS_API_KEY is set.
    // Paystack is only OFFERED in the UI when PAYSTACK_ENABLED=1 (initialize/webhook/verify stay live regardless, for in-flight payments).
    paystackEnabled: ['1', 'true', 'yes', 'on'].includes(env('PAYSTACK_ENABLED').toLowerCase()),
    bachsEnabled: ['1', 'true', 'yes', 'on'].includes(env('BACHS_ENABLED').toLowerCase()),
    bachsKey: env('BACHS_API_KEY'),
    bachsWebhookSecret: env('BACHS_WEBHOOK_SECRET'),
    bachsBase: bachsBaseUrl(env('BACHS_API_KEY'), env('BACHS_ENV'), env('BACHS_API_BASE')),
    bachsSuccessUrl: env('LAS_BACHS_SUCCESS_URL', 'https://lasconverter.lasgconcept.com/account'),
    bachsCancelUrl: env('LAS_BACHS_CANCEL_URL', 'https://lasconverter.lasgconcept.com/account'),
    r2: {
      accountId: env('R2_ACCOUNT_ID'), accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
      bucket: env('R2_BUCKET'), endpoint: env('R2_ENDPOINT'), // R2_ENDPOINT overrides https://<account>.r2.cloudflarestorage.com (tests)
      linkTtlSec: int('LAS_CLOUD_TTL_SEC', 24 * 3600),
    },
  };
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// ------------------------------------------------------------------ JWT (Supabase)
const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function createAuth(cfg, deps) {
  let jwks = null; let jwksAt = 0;
  async function getJwks(force) {
    if (!force && jwks && deps.now() - jwksAt < 10 * 60e3) return jwks;
    const r = await deps.fetch(`${cfg.supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!r.ok) throw new HttpError(503, 'auth_unavailable', 'Could not reach the login service.');
    jwks = (await r.json()).keys || []; jwksAt = deps.now();
    return jwks;
  }

  /** Verify a Supabase access token. Returns { id, email, role } or throws HttpError(401). */
  async function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new HttpError(401, 'bad_token', 'Please log in again.');
    let header; let payload;
    try { header = JSON.parse(b64url(parts[0])); payload = JSON.parse(b64url(parts[1])); } catch (_) { throw new HttpError(401, 'bad_token', 'Please log in again.'); }
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = b64url(parts[2]);
    let ok = false;
    if (header.alg === 'HS256') {
      if (!cfg.jwtSecret) throw new HttpError(401, 'bad_token', 'HS256 tokens are not accepted (SUPABASE_JWT_SECRET not set).');
      const mac = crypto.createHmac('sha256', cfg.jwtSecret).update(data).digest();
      ok = mac.length === sig.length && crypto.timingSafeEqual(mac, sig);
    } else if (header.alg === 'RS256' || header.alg === 'ES256') {
      let key = (await getJwks()).find((k) => k.kid === header.kid);
      if (!key) key = (await getJwks(true)).find((k) => k.kid === header.kid);
      if (!key) throw new HttpError(401, 'bad_token', 'Please log in again.');
      const pub = crypto.createPublicKey({ key, format: 'jwk' });
      ok = header.alg === 'RS256'
        ? crypto.verify('RSA-SHA256', data, pub, sig)
        : crypto.verify('sha256', data, { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
    } else {
      throw new HttpError(401, 'bad_token', 'Unsupported token.');
    }
    if (!ok) throw new HttpError(401, 'bad_token', 'Please log in again.');
    const nowSec = Math.floor(deps.now() / 1000);
    if (!payload.exp || payload.exp < nowSec - 30) throw new HttpError(401, 'token_expired', 'Your session expired. Please log in again.');
    if (payload.aud && payload.aud !== 'authenticated' && !(Array.isArray(payload.aud) && payload.aud.includes('authenticated'))) throw new HttpError(401, 'bad_token', 'Please log in again.');
    if (payload.iss && payload.iss !== `${cfg.supabaseUrl}/auth/v1`) throw new HttpError(401, 'bad_token', 'Please log in again.');
    if (!payload.sub || payload.role === 'anon') throw new HttpError(401, 'bad_token', 'Please log in.');
    return { id: payload.sub, email: payload.email || '', role: payload.role, sessionId: payload.session_id || null };
  }
  return { verify };
}

// ------------------------------------------------------------------ Supabase REST (service role)
function createDb(cfg, deps) {
  const headers = () => ({ apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, 'Content-Type': 'application/json' });
  async function call(method, path, body, prefer) {
    const r = await deps.fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, { method, headers: { ...headers(), ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new HttpError(502, 'db_error', `Database error (${r.status}): ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    async profile(id) { const rows = await call('GET', `profiles?id=eq.${encodeURIComponent(id)}&select=id,email,plan,plan_expires_at,active_session_id`); return rows && rows[0] || null; },
    async claimSession(userId, sessionId) { return call('POST', 'rpc/claim_session', { p_user: userId, p_session: sessionId }); },
    async consumeDownload(userId, limit) { return call('POST', 'rpc/consume_download', { p_user: userId, p_limit: limit }); },
    async usageToday(userId) { const v = await call('POST', 'rpc/usage_today', { p_user: userId }); return Number(v) || 0; },
    async addDownload(row) { return call('POST', 'downloads', row, 'return=minimal'); },
    async history(userId, limit = 50) { return call('GET', `downloads?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=${limit}&select=id,source_url,title,format,quality,size_bytes,r2_key,expires_at,created_at`); },
    async paymentByRef(ref) { const rows = await call('GET', `payments?reference=eq.${encodeURIComponent(ref)}&select=*`); return rows && rows[0] || null; },
    async addPayment(row) { return call('POST', 'payments', row, 'return=minimal'); },
    async claimPayment(ref, patch) { const rows = await call('PATCH', `payments?reference=eq.${encodeURIComponent(ref)}&status=neq.success`, patch, 'return=representation'); return Array.isArray(rows) && rows.length > 0; },
    async updatePayment(ref, patch) { return call('PATCH', `payments?reference=eq.${encodeURIComponent(ref)}`, patch, 'return=minimal'); },
    async setPlan(userId, plan, expiresAt) { return call('PATCH', `profiles?id=eq.${encodeURIComponent(userId)}`, { plan, plan_expires_at: expiresAt, updated_at: new Date(deps.now()).toISOString() }, 'return=minimal'); },
  };
}

function effectivePlan(cfg, profile, now) {
  const premium = profile && profile.plan === 'premium' && profile.plan_expires_at && Date.parse(profile.plan_expires_at) > now;
  const key = premium ? 'premium' : 'free';
  return { key, ...cfg.plans[key], expiresAt: premium ? profile.plan_expires_at : null };
}

// ------------------------------------------------------------------ R2 (S3 API)
function createR2Storage(r2) {
  if (!r2.bucket || !r2.accessKeyId || !r2.secretAccessKey || !(r2.accountId || r2.endpoint)) return null;
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    region: 'auto',
    endpoint: r2.endpoint || `https://${r2.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: !!r2.endpoint,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    // R2 doesn't support the SDK's default streaming checksums (aws-chunked trailers).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async put(key, stream, size, contentType) {
      await client.send(new PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: stream, ContentLength: size, ContentType: contentType }));
    },
    async signedUrl(key, filename, ttlSec = r2.linkTtlSec) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: r2.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${String(filename).replace(/["\\\r\n]/g, '_')}"` }), { expiresIn: Math.min(ttlSec, 7 * 24 * 3600) });
    },
  };
}

// ------------------------------------------------------------------ Paystack
function paystackSignatureOk(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const mac = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(mac); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}


// ------------------------------------------------------------------ Bachs
/** Base URL: BACHS_API_BASE override > BACHS_ENV (sandbox|live) > key prefix (sk_sandbox_ / sk_live_). Defaults to sandbox (never real money by accident). */
function bachsBaseUrl(key, bachsEnv, override) {
  if (override) return String(override).replace(/\/+$/, '');
  const e = String(bachsEnv || '').toLowerCase();
  if (e === 'live' || e === 'production' || e === 'prod') return 'https://api.bachs.io';
  if (e === 'sandbox' || e === 'test') return 'https://sandbox-api.bachs.io';
  return /^sk_live_/.test(String(key || '')) ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Verify a Bachs webhook (https://docs.bachs.io/guides/webhooks/overview).
 * signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)); headers X-Bachs-Timestamp + X-Bachs-Signature,
 * or X-Bachs-Signature-V2 = `t=<ts>,v1=<sig>[,v1=<sig2>]` (several v1 values while a secret is being rotated).
 * Deliveries older/newer than `toleranceSec` (default 300 s) are rejected as replays.
 */
function bachsSignatureOk(secret, rawBody, headers, nowMs = Date.now(), toleranceSec = 300) {
  if (!secret || !headers) return false;
  const h = (n) => { const v = headers[n]; return Array.isArray(v) ? v[0] : v; };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  let ts; let sigs = [];
  const v2 = h('x-bachs-signature-v2');
  if (v2) {
    for (const part of String(v2).split(',')) {
      const i = part.indexOf('='); if (i < 1) continue;
      const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
      if (k === 't') ts = v; else if (k === 'v1') sigs.push(v);
    }
  }
  if (!sigs.length) { ts = h('x-bachs-timestamp'); const s1 = h('x-bachs-signature'); sigs = s1 ? [String(s1).trim()] : []; }
  if (!sigs.length || !/^\d{1,12}$/.test(String(ts || ''))) return false;
  const t = parseInt(ts, 10);
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body])).digest('hex');
  let ok = false;
  for (const s of sigs) { if (safeEqualHex(expected, s)) ok = true; } // no early exit
  return ok;
}

/** "1500.00" -> 150000 (kobo) without floats; null if not a plain decimal. */
function decimalToMinor(v) {
  const m = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(String(v === undefined || v === null ? '' : v).trim());
  if (!m) return null;
  const frac = (m[2] || '').padEnd(2, '0');
  if (/[1-9]/.test(frac.slice(2))) return null; // finer than 2 decimals: refuse to guess
  return parseInt(m[1], 10) * 100 + parseInt(frac.slice(0, 2), 10);
}

// ------------------------------------------------------------------ the layer
function createSaas(deps = {}) {
  const cfg = deps.config || loadConfig();
  const d = { fetch: deps.fetch || globalThis.fetch, now: deps.now || Date.now, log: deps.log || (() => {}) };
  if (!cfg.enabled) return { enabled: false, cfg };
  const auth = createAuth(cfg, d);
  const db = createDb(cfg, d);
  const storage = deps.storage !== undefined ? deps.storage : createR2Storage(cfg.r2);
  const anonDaily = new Map(); // ip|day -> count (users who aren't logged in: apps / old site)

  /**
   * One active device per account (newest login wins): a token whose session is not
   * the profile's active_session_id was signed out by a newer login elsewhere.
   * No active session recorded yet (or no session_id claim) -> allowed.
   */
  function assertActive(user, profile) {
    if (profile && profile.active_session_id && user.sessionId && profile.active_session_id !== user.sessionId) {
      throw new HttpError(401, 'signed_in_elsewhere', 'Your account was signed in on another device.');
    }
  }
  async function verifyActive(token) {
    const user = await auth.verify(token);
    const profile = await db.profile(user.id);
    assertActive(user, profile);
    return { user, profile };
  }

  /** Who is calling? A Supabase user (Bearer), or an anonymous free caller (app token / same-origin). */
  async function identify(req) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) {
      const { user, profile } = await verifyActive(m[1].trim());
      return { user, profile, plan: effectivePlan(cfg, profile, d.now()) };
    }
    if (cfg.requireLogin) throw new HttpError(401, 'login_required', 'Please log in to download.');
    return { user: null, profile: null, plan: { key: 'free', ...cfg.plans.free, expiresAt: null } };
  }

  /** Server-side plan checks for a download request. Throws HttpError(402/429). */
  function checkRequest(who, { format, quality, bitrate }) {
    const p = who.plan;
    // Video quality is capped by the format filter in yt-dlp (short side <= plan
    // maxHeight, so 720x1280 reels count as 720p); only absurd values are refused.
    if (format === 'mp4' && !(quality > 0 && quality <= 4320)) throw new HttpError(400, 'bad_request', 'Invalid quality');
    if (format === 'mp3' && bitrate > p.maxBitrate) {
      throw new HttpError(402, 'premium_required', `MP3 ${bitrate} kbps is a Premium feature (your plan allows up to ${p.maxBitrate} kbps).`);
    }
  }

  async function consume(who, ip) {
    const limit = who.plan.dailyDownloads;
    if (who.user) {
      const r = await db.consumeDownload(who.user.id, limit);
      const row = Array.isArray(r) ? r[0] : r;
      if (!row || !row.allowed) throw new HttpError(429, 'quota_exceeded', `You've used all ${limit} downloads for today${who.plan.key === 'free' ? '. Upgrade to Premium for more' : ''}. The count resets at midnight (UTC).`);
      return row.used;
    }
    const k = `${ip}|${new Date(d.now()).toISOString().slice(0, 10)}`;
    const used = (anonDaily.get(k) || 0) + 1;
    if (used > limit) throw new HttpError(429, 'quota_exceeded', `You've used all ${limit} free downloads for today. Log in or upgrade to Premium for more.`);
    anonDaily.set(k, used);
    if (anonDaily.size > 50000) anonDaily.clear();
    return used;
  }

  /** After a job finished: R2 copy + history row (premium cloud history). Returns { cloudUrl, expiresAt } or null. */
  async function afterJob(who, job, { file, size, name, mime, url, format, quality, fsMod }) {
    if (!who.user) return null;
    let cloud = null;
    if (who.plan.cloud && storage) {
      const key = `u/${who.user.id}/${job.id}/${name}`;
      await storage.put(key, fsMod.createReadStream(file), size, mime);
      const expiresAt = new Date(d.now() + cfg.r2.linkTtlSec * 1000).toISOString();
      cloud = { key, cloudUrl: await storage.signedUrl(key, name), expiresAt };
    }
    await db.addDownload({ user_id: who.user.id, source_url: url, title: name, format, quality, size_bytes: size, r2_key: cloud ? cloud.key : null, expires_at: cloud ? cloud.expiresAt : null }).catch((e) => d.log(`history insert failed: ${e.message}`));
    return cloud;
  }

  // ---------------------------------------------------------------- routes
  async function readBody(req, max = 256 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, 'too_large', 'Body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function me(req) {
    const who = await identify(req);
    if (!who.user) throw new HttpError(401, 'login_required', 'Please log in.');
    const used = await db.usageToday(who.user.id);
    const { key, name, expiresAt, ...limits } = who.plan;
    return { success: true, user: { id: who.user.id, email: who.user.email }, plan: key, planName: name, planExpiresAt: expiresAt, limits, usedToday: used,
      prices: { monthly: cfg.prices.monthly.amount, yearly: cfg.prices.yearly.amount, currency: cfg.currency } };
  }

  async function history(req) {
    const who = await identify(req);
    if (!who.user) throw new HttpError(401, 'login_required', 'Please log in.');
    const rows = await db.history(who.user.id);
    const now = d.now();
    const items = [];
    for (const r of rows || []) {
      const live = r.r2_key && storage && r.expires_at && Date.parse(r.expires_at) > now;
      items.push({ ...r, r2_key: undefined, cloudUrl: live ? await storage.signedUrl(r.r2_key, r.title, Math.floor((Date.parse(r.expires_at) - now) / 1000)) : null });
    }
    return { success: true, items };
  }

  async function payInitialize(req) {
    const who = await identify(req);
    if (!who.user) throw new HttpError(401, 'login_required', 'Please log in to upgrade.');
    if (!cfg.paystackSecret) throw new HttpError(503, 'payments_off', 'Payments are not configured yet.');
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); } catch (_) { throw new HttpError(400, 'bad_request', 'Invalid JSON'); }
    const interval = body.plan === 'yearly' ? 'yearly' : body.plan === 'monthly' ? 'monthly' : null;
    if (!interval) throw new HttpError(400, 'bad_request', 'plan must be "monthly" or "yearly"');
    const price = cfg.prices[interval];
    const reference = `las_${interval}_${crypto.randomBytes(10).toString('hex')}`;
    const r = await d.fetch(`${cfg.paystackBase}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.paystackSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: who.user.email || (who.profile && who.profile.email), amount: price.amount, currency: cfg.currency, reference,
        callback_url: cfg.payCallbackUrl || undefined, metadata: { user_id: who.user.id, plan_interval: interval } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.status) throw new HttpError(502, 'paystack_error', `Payment provider error: ${(j && j.message) || r.status}`);
    await db.addPayment({ reference, user_id: who.user.id, plan_interval: interval, amount: price.amount, currency: cfg.currency, status: 'pending' });
    return { success: true, reference, authorizationUrl: j.data.authorization_url, accessCode: j.data.access_code };
  }

  /** Paystack webhook: verify the signature, re-verify the transaction, then grant the plan (idempotent). */
  async function payWebhook(req) {
    const raw = await readBody(req, 1024 * 1024);
    if (!paystackSignatureOk(cfg.paystackSecret, raw, req.headers['x-paystack-signature'])) throw new HttpError(401, 'bad_signature', 'Invalid signature');
    let evt; try { evt = JSON.parse(raw.toString()); } catch (_) { throw new HttpError(400, 'bad_request', 'Invalid JSON'); }
    if (evt.event !== 'charge.success') return { success: true, ignored: evt.event };
    const ref = evt.data && evt.data.reference;
    return applyPayment(ref, 'webhook');
  }

  /** Verify a reference with Paystack and grant the plan once (shared by webhook + callback verify). */
  async function applyPayment(ref, src, userIdMustMatch) {
    const pay = ref && await db.paymentByRef(ref);
    if (!pay) { d.log(`${src}: unknown reference ${ref}`); if (userIdMustMatch) throw new HttpError(404, 'not_found', 'Payment not found.'); return { success: true, ignored: 'unknown_reference' }; }
    if (userIdMustMatch && pay.user_id !== userIdMustMatch) throw new HttpError(404, 'not_found', 'Payment not found.');
    if (String(pay.reference).startsWith('las_bachs_')) { d.log(`${src}: bachs reference ignored on the Paystack path`); return { success: true, ignored: 'wrong_provider' }; }
    if (pay.status === 'success') return { success: true, duplicate: true };
    // Don't trust the client/webhook body alone: ask Paystack for the transaction.
    const vr = await d.fetch(`${cfg.paystackBase}/transaction/verify/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${cfg.paystackSecret}` } });
    const vj = await vr.json().catch(() => ({}));
    const tx = vj && vj.data;
    if (!vr.ok || !tx || tx.status !== 'success' || Number(tx.amount) < Number(pay.amount) || String(tx.currency).toUpperCase() !== String(pay.currency).toUpperCase()) {
      const pending = tx && ['ongoing', 'pending', 'processing', 'queued'].includes(tx.status);
      if (tx && !pending && tx.status !== 'abandoned') await db.updatePayment(ref, { status: 'failed', raw: tx });
      d.log(`${src}: verification failed for ${ref} (${tx && tx.status})`);
      return { success: true, ignored: 'verification_failed', status: tx && tx.status };
    }
    return grantPlan(pay, ref, src, tx);
  }

  /** Atomically claim the payment, then extend Premium. Shared by Paystack and Bachs. */
  async function grantPlan(pay, ref, src, raw) {
    const now = d.now();
    // Atomically claim the payment so concurrent webhook + verify grant only once.
    if (!(await db.claimPayment(ref, { status: 'success', paid_at: new Date(now).toISOString(), raw }))) return { success: true, duplicate: true };
    const profile = await db.profile(pay.user_id);
    const base = profile && profile.plan === 'premium' && profile.plan_expires_at && Date.parse(profile.plan_expires_at) > now ? Date.parse(profile.plan_expires_at) : now;
    const days = (cfg.prices[pay.plan_interval] || cfg.prices.monthly).days;
    const expires = new Date(base + days * 86400e3).toISOString();
    await db.setPlan(pay.user_id, 'premium', expires);
    d.log(`${src}: ${pay.user_id} premium until ${expires} (${ref})`);
    return { success: true, plan: 'premium', expiresAt: expires };
  }


  // ---------------------------------------------------------------- Bachs
  const bachsReady = () => cfg.bachsEnabled && !!cfg.bachsKey;
  const bachsHeaders = (extra) => ({ Authorization: `Bearer ${cfg.bachsKey}`, 'Content-Type': 'application/json', ...(extra || {}) });

  /** Public: which payment providers the UI may offer. */
  async function payOptions() {
    return { success: true, paystack: cfg.paystackEnabled && !!cfg.paystackSecret, bachs: bachsReady() };
  }

  async function bachsInitialize(req) {
    const who = await identify(req);
    if (!who.user) throw new HttpError(401, 'login_required', 'Please log in to upgrade.');
    if (!bachsReady()) throw new HttpError(503, 'payments_off', 'This payment option is not available yet.');
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); } catch (_) { throw new HttpError(400, 'bad_request', 'Invalid JSON'); }
    const interval = body.plan === 'yearly' ? 'yearly' : body.plan === 'monthly' ? 'monthly' : null;
    if (!interval) throw new HttpError(400, 'bad_request', 'plan must be "monthly" or "yearly"');
    const price = cfg.prices[interval];
    const reference = `las_bachs_${interval}_${crypto.randomBytes(10).toString('hex')}`;
    const email = who.user.email || (who.profile && who.profile.email);
    const payload = {
      pricing: { currency: cfg.currency, amount: (price.amount / 100).toFixed(2) }, // Bachs money = decimal string in major units
      reference,
      metadata: { user_id: who.user.id, plan_interval: interval, reference, app: 'las-converter' },
      success_url: cfg.bachsSuccessUrl,
      cancel_url: cfg.bachsCancelUrl,
      expires_in_minutes: 60,
      ...(email ? { customer: { email } } : {}),
    };
    const r = await d.fetch(`${cfg.bachsBase}/v1/checkout-sessions`, { method: 'POST', headers: bachsHeaders({ 'Idempotency-Key': reference }), body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.checkout_url || !j.checkout_id) throw new HttpError(502, 'bachs_error', `Payment provider error: ${(j && j.detail) || r.status}`);
    await db.addPayment({ reference, user_id: who.user.id, plan_interval: interval, amount: price.amount, currency: cfg.currency, status: 'pending', raw: { provider: 'bachs', checkout_id: j.checkout_id } });
    return { success: true, reference, checkoutUrl: j.checkout_url };
  }

  /**
   * Bachs webhook: verify the signature (raw body, 5 min tolerance), then act on the event.
   * Premium is granted only for checkout.completed / collection.succeeded, after re-reading the checkout from Bachs
   * and checking currency + amount; idempotent through db.claimPayment (events can arrive twice, in any order).
   * Errors we want retried return 5xx; refusals return 400 (Bachs does not retry other 4xx).
   */
  async function bachsWebhook(req) {
    const raw = await readBody(req, 1024 * 1024);
    if (!bachsSignatureOk(cfg.bachsWebhookSecret, raw, req.headers, d.now())) throw new HttpError(400, 'bad_signature', 'Invalid signature');
    let evt; try { evt = JSON.parse(raw.toString()); } catch (_) { throw new HttpError(400, 'bad_request', 'Invalid JSON'); }
    return applyBachsEvent(evt);
  }

  async function applyBachsEvent(evt) {
    const type = evt && evt.type; const data = (evt && evt.data) || {};
    if (!['checkout.completed', 'collection.succeeded', 'collection.underpaid', 'collection.failed', 'checkout.expired'].includes(type)) return { success: true, ignored: type };
    const ref = String(data.reference || (data.metadata && data.metadata.reference) || '');
    const pay = /^las_bachs_[A-Za-z0-9_]{6,100}$/.test(ref) ? await db.paymentByRef(ref) : null;
    if (!pay) { d.log(`bachs ${type}: unknown reference ${ref.slice(0, 60)}`); return { success: true, ignored: 'unknown_reference' }; }
    const storedCheckout = pay.raw && pay.raw.checkout_id;
    if (storedCheckout && data.checkout_id && storedCheckout !== data.checkout_id) { d.log(`bachs ${type}: checkout mismatch for ${ref}`); return { success: true, ignored: 'checkout_mismatch' }; }
    if (data.metadata && data.metadata.user_id && data.metadata.user_id !== pay.user_id) { d.log(`bachs ${type}: user mismatch for ${ref}`); return { success: true, ignored: 'user_mismatch' }; }

    if (type !== 'checkout.completed' && type !== 'collection.succeeded') {
      // Not final / not a payment: never grant, never mark failed (a failed attempt can be retried, an expired
      // checkout can still be paid by transfer). Just keep a note for support.
      if (pay.status !== 'success') await db.updatePayment(ref, { raw: { ...(pay.raw || {}), last_event: type, last_event_id: evt.id, last_event_data: data } }).catch((e) => d.log(`bachs note failed: ${e.message}`));
      d.log(`bachs ${type} for ${ref} (no action)`);
      return { success: true, noted: type };
    }
    if (pay.status === 'success') return { success: true, duplicate: true };
    if (type === 'checkout.completed' && data.payment_status !== 'paid') return { success: true, ignored: 'no_payment' };
    if (type === 'collection.succeeded' && !['SUCCEEDED', 'OVERPAID'].includes(String(data.status || '').toUpperCase())) {
      d.log(`bachs ${type} for ${ref}: status ${data.status} needs manual review`);
      return { success: true, ignored: 'needs_review', status: data.status };
    }
    // Don't trust the webhook body alone: read the checkout from Bachs.
    const checkoutId = data.checkout_id || storedCheckout;
    if (!checkoutId || !cfg.bachsKey) throw new HttpError(503, 'not_ready', 'Cannot verify the checkout yet.');
    let r; try { r = await d.fetch(`${cfg.bachsBase}/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`, { headers: bachsHeaders() }); } catch (e) { throw new HttpError(503, 'not_ready', 'Bachs unreachable.'); }
    const co = await r.json().catch(() => null);
    if (!r.ok || !co) throw new HttpError(503, 'not_ready', `Could not verify the checkout (HTTP ${r.status}).`); // 5xx => Bachs retries
    if (co.status !== 'completed') throw new HttpError(503, 'not_ready', 'Checkout not completed yet.');
    if (co.reference && co.reference !== ref) { d.log(`bachs: reference mismatch on checkout ${checkoutId}`); return { success: true, ignored: 'reference_mismatch' }; }
    // Amount: the checkout's own total (what we asked for); fall back to the signed event when the checkout omits it.
    const amount = co.amount !== undefined && co.amount !== null ? co.amount : data.amount;
    const currency = co.currency || data.currency;
    const minor = decimalToMinor(amount);
    if (minor === null || String(currency).toUpperCase() !== String(pay.currency).toUpperCase() || minor < Number(pay.amount)) {
      d.log(`bachs: amount/currency mismatch for ${ref}: got ${amount} ${currency}, expected ${pay.amount / 100} ${pay.currency}; held for review`);
      await db.updatePayment(ref, { raw: { ...(pay.raw || {}), held_for_review: true, got_amount: amount, got_currency: currency, event_id: evt.id } }).catch(() => {});
      return { success: true, ignored: 'amount_mismatch' };
    }
    return grantPlan(pay, ref, 'bachs-webhook', { provider: 'bachs', checkout_id: checkoutId, event_id: evt.id, event_type: type, charge_id: data.charge_id || (co.charge && co.charge.id) || null, amount, currency });
  }

  /** Callback fallback: logged-in user confirms their own reference (?reference= / ?trxref=). */
  async function payVerify(req) {
    if (!cfg.paystackSecret) throw new HttpError(503, 'payments_off', 'Payments are not configured yet.');
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, 'login_required', 'Please log in.');
    const { user } = await verifyActive(m[1].trim());
    let ref = new URL(req.url, 'http://x').searchParams.get('reference') || '';
    if (!ref) { try { ref = String(JSON.parse((await readBody(req, 16384)).toString() || '{}').reference || ''); } catch (_) {} }
    if (!/^[A-Za-z0-9_.=-]{6,100}$/.test(ref) || ref.startsWith('las_bachs_')) throw new HttpError(400, 'bad_request', 'Missing payment reference.');
    return applyPayment(ref, 'verify', user.id);
  }

  /** Light identity check for polling: user id from a valid Bearer token, else null. */
  async function userId(req) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    return m ? (await verifyActive(m[1].trim())).user.id : null;
  }

  /** POST /api/session/claim: called right after a login; makes this session the only active one. */
  async function sessionClaim(req) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, 'login_required', 'Please log in.');
    const user = await auth.verify(m[1].trim());
    if (!user.sessionId) throw new HttpError(400, 'no_session', 'This token has no session.');
    const r = await db.claimSession(user.id, user.sessionId);
    const ok = Array.isArray(r) ? !!r[0] : !!r;
    if (!ok) throw new HttpError(401, 'signed_in_elsewhere', 'Your account was signed in on another device.');
    return { success: true, sessionId: user.sessionId };
  }

  /** Is cloud transcription available (and allowed for this caller)? */
  async function transcribeStatus(req) {
    let premium = false;
    if (/^Bearer\s+/i.test(String(req.headers.authorization || ''))) {
      try { premium = (await identify(req)).plan.key === 'premium'; } catch (_) { premium = false; }
    }
    return { success: true, enabled: !!cfg.groqKey, premium, model: cfg.groqKey ? cfg.groqModel : null, maxBytes: 24 * 1024 * 1024 };
  }

  /**
   * POST /api/transcribe?lang=en   body: one audio piece (wav/flac/mp3/ogg/webm/m4a, <= 24 MB).
   * The browser cuts long files into pieces and offsets the timestamps itself.
   * Returns { text, language, duration, segments:[{start,end,text}] }.
   */
  async function premiumCaller(req) {
    if (!cfg.groqKey) throw new HttpError(503, 'stt_off', 'Cloud speech is not configured.');
    const who = await identify(req);
    if (!who.user) throw new HttpError(401, 'login_required', 'Please log in.');
    if (who.plan.key !== 'premium') throw new HttpError(402, 'premium_required', 'AI transcription and translation are Premium features.');
    return who;
  }

  const LANG_NAMES = { en: 'English', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo', pcm: 'Nigerian Pidgin', fr: 'French', es: 'Spanish', de: 'German', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', pt: 'Portuguese', it: 'Italian', ru: 'Russian', sw: 'Swahili' };
  // Whisper's large-v3 is clearly better than turbo on these.
  const LOW_RESOURCE = new Set(['yo', 'ha', 'ig', 'sw', 'am', 'so', 'ln']);

  async function groqAudio(endpoint, audio, type, fields) {
    const ext = { 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a' }[type] || 'wav';
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), `audio.${ext}`);
    for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') form.append(k, String(v));
    const r = await d.fetch(`${cfg.groqBase}/audio/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.groqKey}` }, body: form });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw new HttpError(429, 'rate_limited', 'The AI speech service is busy (rate limit). Try again in a minute.');
    if (!r.ok) throw new HttpError(502, 'stt_error', `AI speech service error: ${(j.error && j.error.message) || r.status}`);
    // Drop segments Whisper itself flags as non-speech or looping (hallucinations on silence/music).
    const segments = (j.segments || [])
      .filter((x) => !(x.no_speech_prob > 0.6 && x.avg_logprob < -0.8) && !(x.compression_ratio > 2.6))
      .map((x) => ({ start: x.start, end: x.end, text: String(x.text || '').trim() })).filter((x) => x.text);
    return { segments, language: j.language || null, duration: j.duration || null };
  }

  /** Translate an array of short texts with the Groq LLM, keeping the 1:1 line order. */
  async function llmTranslate(texts, source, target) {
    const out = [];
    const src = LANG_NAMES[source] || source || 'the source language';
    const tgt = LANG_NAMES[target] || target || 'English';
    for (let i = 0; i < texts.length; i += 25) {
      const batch = texts.slice(i, i + 25);
      const body = {
        model: cfg.groqLlmModel, temperature: 0, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `You are a professional subtitle translator. Translate each line from ${src} to ${tgt}. The lines are consecutive speech-recognition subtitles, so use the neighbouring lines for context, keep names, keep the meaning natural and concise, and do not add explanations. The text comes from automatic speech recognition and can be noisy: tone marks and under-dots may be missing, words may be split or merged, and names/loanwords are spelled phonetically (for Yoruba e.g. "busi" = Bush, "nukilia" = nuclear, "koria ariwa" = North Korea). Reconstruct the most likely meaning, but never invent content that the line does not support; if part of a line is unintelligible, translate what you can. If a line is already in ${tgt}, keep it. Reply with JSON {"t": [..]} containing exactly ${batch.length} strings, one per input line, in the same order.` },
          { role: 'user', content: JSON.stringify(batch.map((t, k) => `${k + 1}. ${t}`)) },
        ],
      };
      let arr = null; let lastErr = null;
      for (let attempt = 0; attempt < 4 && !arr; attempt++) {
        // attempt 0/1: main model, 2/3: smaller fallback model (also used when the main one is rate-limited)
        const model = attempt < 2 ? cfg.groqLlmModel : (cfg.groqLlmFallback || 'openai/gpt-oss-20b');
        const b = { ...body, model };
        if (/gpt-oss/.test(model)) b.reasoning_effort = 'low';
        if (attempt % 2 === 1) delete b.response_format; // JSON-mode validation failures: retry in free text
        const r = await d.fetch(`${cfg.groqBase}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.groqKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 429) {
          lastErr = new HttpError(429, 'rate_limited', 'The AI translation service is busy (rate limit). Try again in a minute.');
          const wait = Math.min(20, Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 6);
          if (attempt < 3) await new Promise((res) => setTimeout(res, (d.sleepScale ?? 1) * wait * 1000));
          continue;
        }
        if (!r.ok) { lastErr = new HttpError(502, 'translate_error', `AI translation error: ${(j.error && j.error.message) || r.status}`); continue; }
        try {
          const c = String(j.choices[0].message.content || '');
          const t = JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)).t;
          if (Array.isArray(t) && t.length === batch.length) arr = t.map((x) => String(x || '').replace(/^\d+\.\s*/, '').trim());
          else lastErr = new HttpError(502, 'translate_error', 'AI translation returned an unexpected answer. Please try again.');
        } catch (_) { arr = null; }
      }
      if (!arr && lastErr) throw lastErr;
      if (!arr) throw new HttpError(502, 'translate_error', 'AI translation returned an unexpected answer. Please try again.');
      out.push(...arr);
    }
    return out;
  }

  /**
   * POST /api/transcribe?lang=yo&target=en&mode=asr|llm   body: one audio piece (<= 24 MB).
   *  - no target (or target == lang): transcription (turbo; large-v3 for low-resource languages)
   *  - target=en, mode=asr: Whisper large-v3 speech translation straight to English
   *  - mode=llm (default for translations): large-v3 transcription in the spoken language,
   *    then line-by-line LLM translation (keeps both texts, any target language)
   * Returns { text, language, segments:[{start,end,text}], sourceSegments? }.
   */
  async function transcribe(req) {
    await premiumCaller(req);
    const audio = await readBody(req, 24 * 1024 * 1024);
    if (audio.length < 1000) throw new HttpError(400, 'bad_request', 'No audio received.');
    const q = new URL(req.url, 'http://x').searchParams;
    const clean = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
    let lang = clean(q.get('lang')); if (lang === 'aut') lang = '';
    const target = clean(q.get('target'));
    const mode = q.get('mode') === 'asr' ? 'asr' : 'llm';
    const type = /^audio\/[\w.+-]+$/.test(String(req.headers['content-type'] || '')) ? req.headers['content-type'] : 'audio/wav';
    // Whisper has no Pidgin or Igbo code: Pidgin is transcribed as English, Igbo auto-detected.
    const whisperLang = lang === 'pcm' ? 'en' : (lang === 'ig' ? '' : lang);
    const translating = !!target && target !== lang;
    if (!translating) {
      const model = LOW_RESOURCE.has(lang) ? cfg.groqLargeModel : cfg.groqModel;
      const r = await groqAudio('transcriptions', audio, type, { model, response_format: 'verbose_json', temperature: 0, language: whisperLang });
      return { success: true, text: r.segments.map((x) => x.text).join(' '), language: r.language || lang || null, duration: r.duration, segments: r.segments, model };
    }
    if (mode === 'asr' && target === 'en') {
      const r = await groqAudio('translations', audio, type, { model: cfg.groqLargeModel, response_format: 'verbose_json', temperature: 0 });
      return { success: true, text: r.segments.map((x) => x.text).join(' '), language: 'en', sourceLanguage: lang || r.language, duration: r.duration, segments: r.segments, model: cfg.groqLargeModel };
    }
    const src = await groqAudio('transcriptions', audio, type, { model: cfg.groqLargeModel, response_format: 'verbose_json', temperature: 0, language: whisperLang });
    const translated = src.segments.length ? await llmTranslate(src.segments.map((x) => x.text), lang || src.language, target) : [];
    const segments = src.segments.map((x, i) => ({ start: x.start, end: x.end, text: translated[i] || '' })).filter((x) => x.text);
    return { success: true, text: segments.map((x) => x.text).join(' '), language: target, sourceLanguage: lang || src.language, duration: src.duration, segments, sourceSegments: src.segments, model: `${cfg.groqLargeModel}+${cfg.groqLlmModel}` };
  }

  /** POST /api/translate { source, target, texts: [..] }  (Premium) -> { texts: [..] } */
  async function translateText(req) {
    await premiumCaller(req);
    let body = {};
    try { body = JSON.parse((await readBody(req, 512 * 1024)).toString() || '{}'); } catch (_) { throw new HttpError(400, 'bad_request', 'Invalid JSON'); }
    const texts = Array.isArray(body.texts) ? body.texts.map((t) => String(t || '').slice(0, 2000)).slice(0, 2000) : [];
    if (!texts.length) throw new HttpError(400, 'bad_request', 'Nothing to translate.');
    const clean = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
    const target = clean(body.target) || 'en';
    return { success: true, texts: await llmTranslate(texts, clean(body.source), target), model: cfg.groqLlmModel };
  }

  /**
   * POST /api/local-download  { format: 'mp4'|'mp3', quality, bitrate }
   * The PC app downloads YouTube etc. with its own local yt-dlp; it calls this
   * first so the download needs a login and counts toward the same daily quota
   * and plan caps as the website. Returns the caps the app must apply.
   */
  async function localDownload(req) {
    const who = await identify(req);
    if (!who.user) throw new HttpError(401, 'login_required', 'Please log in to download.');
    let body = {};
    try { body = JSON.parse((await readBody(req, 16384)).toString() || '{}'); } catch (_) { throw new HttpError(400, 'bad_request', 'Invalid JSON'); }
    const format = body.format === 'mp3' ? 'mp3' : 'mp4';
    const quality = parseInt(body.quality, 10) || 720;
    const bitrate = parseInt(body.bitrate, 10) || 192;
    const p = who.plan;
    if (format === 'mp4' && quality > p.maxHeight) throw new HttpError(402, 'premium_required', `${quality}p is a Premium feature (your plan allows up to ${p.maxHeight}p).`);
    checkRequest(who, { format, quality, bitrate });
    const used = await consume(who, null);
    return { success: true, plan: p.key, used, limit: p.dailyDownloads, maxHeight: p.maxHeight, maxBitrate: p.maxBitrate, maxVideoSec: p.maxVideoSec, maxAudioSec: p.maxAudioSec };
  }

  const routes = {
    'POST /api/local-download': localDownload,
    'GET /api/transcribe/status': transcribeStatus,
    'POST /api/transcribe': transcribe,
    'POST /api/translate': translateText,
    'GET /api/me': me,
    'GET /api/history': history,
    'POST /api/pay/initialize': payInitialize,
    'POST /api/pay/webhook': payWebhook,
    'POST /api/pay/verify': payVerify,
    'GET /api/pay/options': payOptions,
    'POST /api/pay/bachs/initialize': bachsInitialize,
    'POST /api/pay/bachs/webhook': bachsWebhook,
    'POST /api/session/claim': sessionClaim,
  };
  return { enabled: true, cfg, identify, userId, checkRequest, consume, afterJob, routes, storage, HttpError };
}

module.exports = { createSaas, loadConfig, paystackSignatureOk, bachsSignatureOk, bachsBaseUrl, decimalToMinor, effectivePlan, HttpError };
