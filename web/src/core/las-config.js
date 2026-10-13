/**
 * Build-time configuration (replaced by build-scripts/build-web.js from the
 * LAS_BUILTIN_SERVER / LAS_BUILTIN_TOKEN environment variables).
 * The mobile app uses this hosted download server by default; users can
 * override it under Settings > Download server (advanced).
 */
window.LAS_BUILTIN_SERVER = '__LAS_BUILTIN_SERVER__';
window.LAS_BUILTIN_TOKEN = '__LAS_BUILTIN_TOKEN__';
window.LAS_APP_VERSION = '1.9.1';
