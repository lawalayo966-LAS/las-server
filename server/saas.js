'use strict';
/**
 * LAS Converter SaaS layer for the public server: Supabase auth (JWT), plans
 * and quotas (Supabase tables), Cloudflare R2 cloud copies (S3 API, signed
 * links) and Paystack payments (initialize + signed webhook).
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
    plans,
    prices: { // amounts in kobo (NGN x 100)
      monthly: { amount: int('LAS_PRICE_MONTHLY_KOBO', 150000), days: 30 },
      yearly: { amount: int('LAS_PRICE_YEARLY_KOBO', 1200000), days: 365 },
    },
    currency: env('LAS_CURRENCY', 'NGN'),
    paystackSecret: env('PAYSTACK_SECRET_KEY'),
    paystackBase: env('PAYSTACK_API_BASE', 'https://api.paystack.co').replace(/\/+$/, ''),
    payCallbackUrl: env('LAS_PAY_CALLBACK_URL'),
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
    return { id: payload.sub, email: payload.email || '', role: payload.role };
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
    async profile(id) { const rows = await call('GET', `profiles?id=eq.${encodeURIComponent(id)}&select=id,email,plan,plan_expires_at`); return rows && rows[0] || null; },
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

// ------------------------------------------------------------------ the layer
function createSaas(deps = {}) {
  const cfg = deps.config || loadConfig();
  const d = { fetch: deps.fetch || globalThis.fetch, now: deps.now || Date.now, log: deps.log || (() => {}) };
  if (!cfg.enabled) return { enabled: false, cfg };
  const auth = createAuth(cfg, d);
  const db = createDb(cfg, d);
  const storage = deps.storage !== undefined ? deps.storage : createR2Storage(cfg.r2);
  const anonDaily = new Map(); // ip|day -> count (users who aren't logged in: apps / old site)

  /** Who is calling? A Supabase user (Bearer), or an anonymous free caller (app token / same-origin). */
  async function identify(req) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) {
      const user = await auth.verify(m[1].trim());
      const profile = await db.profile(user.id);
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
    const now = d.now();
    // Atomically claim the payment so concurrent webhook + verify grant only once.
    if (!(await db.claimPayment(ref, { status: 'success', paid_at: new Date(now).toISOString(), raw: tx }))) return { success: true, duplicate: true };
    const profile = await db.profile(pay.user_id);
    const base = profile && profile.plan === 'premium' && profile.plan_expires_at && Date.parse(profile.plan_expires_at) > now ? Date.parse(profile.plan_expires_at) : now;
    const days = (cfg.prices[pay.plan_interval] || cfg.prices.monthly).days;
    const expires = new Date(base + days * 86400e3).toISOString();
    await db.setPlan(pay.user_id, 'premium', expires);
    d.log(`${src}: ${pay.user_id} premium until ${expires} (${ref})`);
    return { success: true, plan: 'premium', expiresAt: expires };
  }

  /** Callback fallback: logged-in user confirms their own reference (?reference= / ?trxref=). */
  async function payVerify(req) {
    if (!cfg.paystackSecret) throw new HttpError(503, 'payments_off', 'Payments are not configured yet.');
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, 'login_required', 'Please log in.');
    const user = await auth.verify(m[1].trim());
    let ref = new URL(req.url, 'http://x').searchParams.get('reference') || '';
    if (!ref) { try { ref = String(JSON.parse((await readBody(req, 16384)).toString() || '{}').reference || ''); } catch (_) {} }
    if (!/^[A-Za-z0-9_.=-]{6,100}$/.test(ref)) throw new HttpError(400, 'bad_request', 'Missing payment reference.');
    return applyPayment(ref, 'verify', user.id);
  }

  /** Light identity check for polling: user id from a valid Bearer token, else null. */
  async function userId(req) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    return m ? (await auth.verify(m[1].trim())).id : null;
  }

  const routes = {
    'GET /api/me': me,
    'GET /api/history': history,
    'POST /api/pay/initialize': payInitialize,
    'POST /api/pay/webhook': payWebhook,
    'POST /api/pay/verify': payVerify,
  };
  return { enabled: true, cfg, identify, userId, checkRequest, consume, afterJob, routes, storage, HttpError };
}

module.exports = { createSaas, loadConfig, paystackSignatureOk, effectivePlan, HttpError };
