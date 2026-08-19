/**
 * dsh-client-paste-image — host half: config bridge.
 *
 * Static client plugins receive NO config on the browser side (the boot
 * manifest carries only id/url/rev/inject and the client loader creates
 * entries with `loader.create({ name })`), so the `textOnlyRoutes` the user
 * writes in cordis.patch.yml never reaches the browser through the module
 * pipeline. This half DOES get plugin config from the host-side loader
 * entry, and bridges it over HTTP: GET /plugin-paste-image-config answers
 * { version, textOnlyRoutes } for the client half to cache at boot.
 *
 * The upload route itself belongs to dsh-drop-caret (/api/dsh-drop); this
 * package adds no storage of its own.
 *
 * The route sits behind the same browser-trust fence as /api (loopback
 * Host + Sec-Fetch-Site/Origin checks) — a cross-site page gets nothing.
 */

const ROUTE = '/plugin-paste-image-config';
// Keep in sync with package.json version; echoed in responses so the
// RUNNING host version is verifiable with a single curl.
const VERSION = '0.3.0';

/** True for localhost / [::1] / any 127.x.x.x (framework api-request-trust semantics). */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Browser-trust fence mirroring the framework's isTrustedApiRequest(). */
function isTrustedRequest(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return false;
    }
    if (originUrl.host !== host) return false;
  }
  return true;
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function apply(ctx, config) {
  const routes = Array.isArray(config && config.textOnlyRoutes)
    ? config.textOnlyRoutes.map(String)
    : [];

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { error: 'untrusted' });
        return;
      }
      writeJson(res, 200, { version: VERSION, textOnlyRoutes: routes });
    }
  }));
}

export const inject = ['webServer'];
