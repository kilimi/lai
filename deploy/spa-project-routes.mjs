/**
 * Browser (SPA) routes under /projects that must NOT be proxied to the FastAPI API.
 * Keep in sync with deploy/nginx/default.conf SPA location blocks.
 *
 * @param {string} url Pathname, optionally with query string.
 * @returns {boolean}
 */
export function isSpaProjectRoute(url) {
  const path = (url || "").split("?")[0].replace(/\/+$/, "") || "/";

  if (/^\/projects\/new(\/dataset)?$/.test(path)) return true;
  if (/^\/projects\/\d+\/(evaluations|models|exports)$/.test(path)) return true;
  if (/^\/projects\/\d+\/datasets$/.test(path)) return true;
  if (/^\/projects\/\d+\/datasets\/\d+/.test(path)) return true;
  if (/^\/projects\/\d+\/edit$/.test(path)) return true;

  return false;
}
