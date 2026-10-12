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
