# las-server: LAS Converter download server

This is the hosted download server used by the **LAS Converter** mobile app. It
fetches media with [yt-dlp](https://github.com/yt-dlp/yt-dlp) (plus deno and
ffmpeg) and streams the file back to the app. It contains no app UI.

## Endpoints
- `GET /api/health`
- `GET /api/media-info?url=…`
- `POST /api/jobs?url=…&format=mp4|mp3&quality=…` → `{id}` (starts a server-side download)
- `GET /api/jobs/:id` → state, percent, speed, ETA
- `GET /api/jobs/:id/file` (supports `Range`, so transfers resume) · `DELETE /api/jobs/:id` (cancel)
- `GET /api/media-download?url=…&format=mp4|mp3&quality=…` (legacy single request)

Requests need the `X-LAS-Token` header (or `?token=`), matching `LAS_API_TOKEN`.

## Configuration (env)
| Var | Default |
|---|---|
| `PORT` | 8080 |
| `LAS_API_TOKEN` | required |
| `LAS_RATE_PER_HOUR` | 30 per IP |
| `LAS_MAX_MEDIA_DOWNLOADS` | 2 concurrent |
| `LAS_MAX_DURATION_SEC` | 1800 |
| `LAS_MAX_FILESIZE` | 300M |
| `SERVER_COOKIES` | optional cookies.txt content |

## Run
```
docker build -t las-server .
docker run -p 8080:8080 -e LAS_API_TOKEN=change-me las-server
```

Only download content you have the rights to. MIT licensed.

## Optional: cookies and proxy (YouTube bot checks)

- `SERVER_COOKIES`: set this as a **secret** env var. Its value is the full contents of a Netscape-format `cookies.txt` (use a throwaway account; the cookies can get it flagged). You can use `LAS_SERVER_COOKIES_FILE=/etc/secrets/cookies.txt` with a Render secret file instead.
- `LAS_PROXY`: the proxy URL yt-dlp should use, for example `http://user:pass@host:port`. The run log redacts the credentials.
- `LAS_MAX_AUDIO_DURATION_SEC`: the longest video that can still be downloaded as MP3 (default: the video cap or 4 h, whichever is larger). Longer videos are offered as MP3 only.

## Website

`web/` is the static LAS CONVERT web build (from the private app repo: `npm run build`, then `dist/` without `downloads/` and the Electron/Capacitor platform files). The server serves it at `/`. API calls from the same origin don't need `LAS_API_TOKEN`, but the per-IP rate limit (`LAS_RATE_PER_HOUR`) still applies. Conversions run in the visitor's browser with the single-thread ffmpeg.wasm core, so no COOP/COEP headers are needed. Set `LAS_WEB_DIR` to serve a different folder.

## SaaS mode (Supabase, R2, Paystack)

The SaaS layer turns on when `SUPABASE_URL` is set; see `.env.example` and `DEPLOY.md` in las-converter-web. In SaaS mode:

- `Authorization: Bearer <Supabase access token>` is verified on every API call (HS256 with `SUPABASE_JWT_SECRET`, or the project's JWKS for RS256/ES256).
- The plan is read from `profiles`, and the daily quota is counted in `usage_daily` through the `consume_download` RPC.
- Free downloads are capped at 720p (short side) and 192 kbps MP3. Premium downloads skip the queue, and a copy goes to R2 with a 24 h signed link.
- New endpoints: `GET /api/me`, `GET /api/history`, `POST /api/pay/initialize`, `POST /api/pay/webhook` (Paystack HMAC-SHA512 signature, re-verified with the Paystack verify API).
- Bachs (optional, flag `BACHS_ENABLED=1`): `GET /api/pay/options`, `POST /api/pay/bachs/initialize` (hosted checkout, product-less NGN `pricing`), `POST /api/pay/bachs/webhook` (`X-Bachs-Signature(-V2)` HMAC-SHA256 over `timestamp.rawBody`, 5 min tolerance; grants Premium on `checkout.completed`/`collection.succeeded` after re-reading the checkout and checking amount/currency). Env: `BACHS_API_KEY`, `BACHS_WEBHOOK_SECRET`, optional `BACHS_ENV`.
- Tests: `npm test` (offline mocks). `npm run e2e:saas` runs the real server against mocked Supabase, R2 and Paystack with a live Facebook download.
