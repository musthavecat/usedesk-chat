/**
 * Runtime account-config discovery. Usedesk bakes per-account settings into
 * the tail of the public widget bundle (`widget_<companyId>.js`: minified
 * webpack on top, a readable bootstrap object at the bottom). Their S3
 * honours Range requests, so ~8 KB from the end is enough to read the live
 * `pubsubUrl` / `centrifugoEnabled` / upload endpoints — no hardcoded hosts,
 * and a host migration or a Centrifugo flip is picked up automatically.
 *
 * ⚠️ CORS: Usedesk's S3 sends no `Access-Control-Allow-Origin`, and the
 * `Range` header forces a preflight, so a DIRECT browser fetch is blocked.
 * In Node / CLI / cron there's no CORS — discovery works as-is. In the
 * browser, point `url` at a same-origin proxy that forwards the tail (any
 * server runtime can range-fetch the bundle and echo it with CORS).
 */

export interface DiscoveredConfig {
  /** socket.io chat host, e.g. `https://pubsubsec4.usedesk.ru`. */
  pubsubUrl?: string;
  /** Account is on the Centrifugo transport instead of socket.io. */
  centrifugoEnabled?: boolean;
  /** `wss://centrifugo.usedesk.ru/connection/websocket` when relevant. */
  centrifugoConnectionHost?: string;
  /** REST base, e.g. `https://secure.usedesk.ru/uapi/v1`. */
  apiDomain?: string;
  fileUploadUrl?: string;
}

export const widgetBundleUrl = (companyId: string): string =>
  `https://s3.usedesk.ru/lib/secure.usedesk.ru/widget_${companyId}.js`;

const TAIL_BYTES = 8192;

const pick = (text: string, key: string): string | undefined =>
  text.match(new RegExp(`${key}:\\s*["']([^"']*)["']`))?.[1] || undefined;

/**
 * Fetch + parse the live account config. Throws on network/HTTP failure;
 * resolves `{}` if the tail didn't contain the bootstrap (callers fall back
 * to their baked-in defaults either way).
 */
export const discoverConfig = async (
  companyId: string,
  options?: {
    tailBytes?: number;
    /**
     * Override the fetch URL — point at a same-origin proxy in the browser
     * (it should return the bundle tail or the parsed config as text/JSON).
     * Defaults to a direct Range fetch of the S3 bundle (Node/CLI only).
     */
    url?: string;
  },
): Promise<DiscoveredConfig> => {
  const direct = !options?.url;
  let fetchUrl = widgetBundleUrl(companyId);
  if (options?.url) {
    // Append companyId to the proxy URL (preserving any existing query).
    const sep = options.url.includes("?") ? "&" : "?";
    fetchUrl = `${options.url}${sep}companyId=${encodeURIComponent(companyId)}`;
  }
  const res = await fetch(fetchUrl, {
    headers: direct
      ? { Range: `bytes=-${options?.tailBytes ?? TAIL_BYTES}` }
      : undefined,
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`usedesk_chat_discovery_failed: ${res.status}`);
  }
  const tail = await res.text();
  // A proxy may already return parsed JSON instead of the raw tail.
  if (!direct && tail.trim().startsWith("{")) {
    try {
      return JSON.parse(tail) as DiscoveredConfig;
    } catch {
      // fall through to regex parsing of a raw-tail proxy response
    }
  }
  return {
    pubsubUrl: pick(tail, "pubsubUrl"),
    centrifugoEnabled: Boolean(pick(tail, "centrifugoEnabled")),
    centrifugoConnectionHost: pick(tail, "centrifugoConnectionHost"),
    apiDomain: pick(tail, "apiDomain"),
    fileUploadUrl: pick(tail, "fileUploadUrl"),
  };
};

// ── cached variant (browser) ─────────────────────────────────────────────

const CACHE_PREFIX = "usedesk_chat_config_";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEnvelope {
  config: DiscoveredConfig;
  expires: number;
}

const readCache = (companyId: string): DiscoveredConfig | null => {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + companyId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (!parsed?.config || Date.now() > parsed.expires) return null;
    return parsed.config;
  } catch {
    return null;
  }
};

const writeCache = (companyId: string, config: DiscoveredConfig): void => {
  try {
    const envelope: CacheEnvelope = {
      config,
      expires: Date.now() + CACHE_TTL_MS,
    };
    localStorage.setItem(CACHE_PREFIX + companyId, JSON.stringify(envelope));
  } catch {
    // private mode / quota — discovery just runs again next time
  }
};

/**
 * `discoverConfig` with a localStorage day-cache. Never throws — returns
 * `null` when discovery fails so callers use their baked-in defaults.
 */
export const cachedDiscoverConfig = async (
  companyId: string,
  options?: { url?: string },
): Promise<DiscoveredConfig | null> => {
  const cached = readCache(companyId);
  if (cached) return cached;
  try {
    const config = await discoverConfig(companyId, options);
    if (config.pubsubUrl) writeCache(companyId, config);
    return config;
  } catch {
    return null;
  }
};
