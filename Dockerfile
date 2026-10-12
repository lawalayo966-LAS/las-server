# LAS CONVERT hosted download server (yt-dlp + deno + ffmpeg), for the mobile app.
#   docker build -t las-server .
#   docker run -p 8080:8080 -e LAS_API_TOKEN=change-me las-server
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    LAS_HOST=0.0.0.0 \
    LAS_TRUST_PROXY=1 \
    LAS_YTDLP_DIR=/home/node/.las-convert

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Production deps only (bundled ffmpeg/ffprobe from @ffmpeg-installer; no Electron).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
   

COPY server ./server
COPY build-scripts/fetch-ytdlp.js ./build-scripts/fetch-ytdlp.js
# Standalone yt-dlp + deno into resources/bin (copied to LAS_YTDLP_DIR and kept up to date at runtime).
RUN node build-scripts/fetch-ytdlp.js --platform linux \
    && mkdir -p "$LAS_YTDLP_DIR" && chown -R node:node /app/resources "$LAS_YTDLP_DIR"

USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/public-server.js"]
