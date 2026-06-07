function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function envWantsSameOriginApi(): boolean {
  const envUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
  return envUrl === "" || envUrl === "SAME_ORIGIN" || envUrl === "/";
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/**
 * True when the configured API is a local backend (localhost:9999) but the SPA is
 * served on another origin (e.g. nginx :8089). Route through the page origin proxy.
 */
export function shouldProxyApiViaPageOrigin(configuredBase: string): boolean {
  if (typeof window === "undefined") return false;

  try {
    const api = new URL(configuredBase);
    if (!isLoopbackHost(api.hostname)) return false;

    const pagePort = effectivePort(new URL(window.location.origin));
    const apiPort = effectivePort(api);
    if (apiPort !== pagePort) return true;

    return !isLoopbackHost(window.location.hostname);
  } catch {
    return false;
  }
}

/**
 * Rewrite API host for the current browser context.
 * - LAN page + loopback API → use page host (avoids Private Network Access blocks).
 * - Loopback page + different loopback hostname → align with page (localhost vs 127.0.0.1).
 */
export function normalizeApiBaseForBrowser(base: string): string {
  if (typeof window === "undefined") {
    return base.replace(/\/+$/, "");
  }

  try {
    const pageHost = window.location.hostname;
    const api = new URL(base);
    const pageIsLoopback = isLoopbackHost(pageHost);
    const apiIsLoopback = isLoopbackHost(api.hostname);

    if (!pageIsLoopback && apiIsLoopback) {
      api.hostname = pageHost;
    } else if (pageIsLoopback && apiIsLoopback && api.hostname !== pageHost) {
      api.hostname = pageHost;
    }

    return api.toString().replace(/\/+$/, "");
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/**
 * Non-loopback API URL explicitly saved in Settings (remote deployments only).
 */
function getConfiguredRemoteApiUrl(): string | undefined {
  const saved = localStorage.getItem("apiBaseUrl")?.trim();
  if (!saved) return undefined;
  try {
    const href = saved.includes("://") ? saved : `http://${saved}`;
    const api = new URL(href);
    if (!isLoopbackHost(api.hostname)) {
      return api.toString().replace(/\/+$/, "");
    }
  } catch {
    /* ignore invalid saved URL */
  }
  return undefined;
}

/**
 * API base URL for browser requests.
 * Always use the page origin (Vite / nginx API proxy) unless Settings points at a
 * remote host. Avoids Private Network Access blocks when opening the UI by LAN IP.
 */
export const getApiBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    const remote = getConfiguredRemoteApiUrl();
    if (remote) {
      return normalizeApiBaseForBrowser(remote);
    }
    return window.location.origin;
  }

  const envUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (envWantsSameOriginApi()) {
    return "http://localhost:9999";
  }
  return (envUrl || "http://localhost:9999").replace(/\/+$/, "");
};

/** Build an absolute API URL for a path (and optional query params). */
export function buildApiUrl(
  path: string,
  query?: Record<string, string>,
): string {
  const base = getApiBaseUrl().replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const origin =
    base ||
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:9999");
  const url = new URL(normalizedPath, `${origin}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

const PRIVATE_NETWORK_HINT =
  "The browser blocked access to the API (often when the app is opened by LAN IP but the API URL is localhost). " +
  "Open the app using the same host you use for the API, clear API URL in Settings, or rebuild with VITE_API_URL=SAME_ORIGIN.";

function isPrivateNetworkFetchError(message: string, requestUrl: string): boolean {
  if (message.includes("ERR_ACCESS_DENIED")) return true;
  try {
    const api = new URL(requestUrl);
    return isLoopbackHost(api.hostname);
  } catch {
    return false;
  }
}

/** POST multipart/form-data to the API (test inference, uploads, etc.). */
export async function postApiFormData(
  path: string,
  formData: FormData,
  query?: Record<string, string>,
): Promise<Response> {
  const url = buildApiUrl(path, query);
  const sameOrigin =
    typeof window !== "undefined" && url.startsWith(window.location.origin);
  try {
    return await fetch(url, {
      method: "POST",
      body: formData,
      mode: sameOrigin ? "same-origin" : "cors",
      credentials: "omit",
      cache: "no-cache",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Failed to fetch") ||
      message.includes("NetworkError")
    ) {
      const hint = isPrivateNetworkFetchError(message, url)
        ? PRIVATE_NETWORK_HINT
        : `Request to ${url} failed. Check that the backend is running and reachable from this device.`;
      throw new Error(`${message}. ${hint}`);
    }
    throw error;
  }
}

/** Origin used for ``<img src>`` — always includes the page port when in a browser. */
export function getMediaBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin.replace(/\/+$/, "");
  }
  return getApiBaseUrl().replace(/\/+$/, "");
}

/**
 * Turn backend-relative media paths into absolute URLs the browser can load.
 * Dataset thumbnails and image URLs are often stored as `/static/projects/...`
 * while the SPA runs on another origin (e.g. Vite :8080 vs API :9999).
 */
export function resolveBackendMediaUrl(
  href: string | undefined | null
): string | undefined {
  if (href == null) return undefined;
  const h = String(href).trim();
  if (!h) return undefined;
  if (h.startsWith("data:") || h.startsWith("blob:")) {
    return h;
  }

  const base = getMediaBaseUrl();

  if (h.startsWith("http://") || h.startsWith("https://")) {
    try {
      const parsed = new URL(h);
      // API/proxy may emit http://localhost/static/... (no :8089) or http://backend:8000/...
      if (
        parsed.pathname.startsWith("/static/") ||
        parsed.pathname.startsWith("/data/")
      ) {
        return `${base}${parsed.pathname}${parsed.search}`;
      }
    } catch {
      /* keep original */
    }
    return h;
  }

  if (h.startsWith("/")) {
    return `${base}${h}`;
  }
  return h;
}

/** Normalize image url/thumbnailUrl from API for the current browser origin. */
export function normalizeImageMedia<T extends { url?: string; thumbnailUrl?: string }>(
  image: T,
): T {
  return {
    ...image,
    ...(image.url !== undefined
      ? { url: resolveBackendMediaUrl(image.url) ?? image.url }
      : {}),
    ...(image.thumbnailUrl !== undefined
      ? { thumbnailUrl: resolveBackendMediaUrl(image.thumbnailUrl) ?? image.thumbnailUrl }
      : {}),
  };
}

// Check if a URL is accessible
const isUrlAccessible = async (url: string): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${url}/health-check`, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    console.warn(`API endpoint ${url} is not accessible:`, error);
    return false;
  }
};

export const API_CONFIG = {
  get baseUrl() {
    return getApiBaseUrl();
  },
  isAccessible: async (): Promise<boolean> => {
    return await isUrlAccessible(getApiBaseUrl());
  },
};
