/**
 * Chat-session token persistence, bidirectionally compatible with the official
 * Usedesk widget: same key (`usedesk_messenger_token`) in BOTH a cookie and a
 * localStorage envelope `{data, time}` — the widget reads the cookie first and
 * falls back to localStorage. Visitors who already chatted via the script
 * widget keep their conversation on the native client, and the script fallback
 * picks up tokens we save.
 *
 * Note: the widget's own localStorage TTL check is broken (`getTime > time`
 * compares a function to a number), so legacy tokens effectively never expire
 * there. We mirror that: `time` is written for compat but not enforced on read.
 */

const TOKEN_KEY = "usedesk_messenger_token";
const TTL_MS = 24 * 60 * 60 * 1000;

const readCookie = (): string | null => {
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${TOKEN_KEY}=([^;]+)`),
    );
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
};

const readLocalStorage = (): string | null => {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: unknown };
    return typeof parsed?.data === "string" && parsed.data ? parsed.data : null;
  } catch {
    return null;
  }
};

export const getStoredToken = (): string | null =>
  readCookie() ?? readLocalStorage();

export const storeToken = (token: string): void => {
  const expires = new Date(Date.now() + TTL_MS);
  try {
    localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ data: token, time: +expires }),
    );
  } catch {
    // private mode / quota — cookie below still covers the session
  }
  try {
    document.cookie = `${TOKEN_KEY}=${encodeURIComponent(token)}; expires=${expires.toUTCString()}; path=/`;
  } catch {
    // noop
  }
};

export const clearToken = (): void => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // noop
  }
  try {
    document.cookie = `${TOKEN_KEY}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  } catch {
    // noop
  }
};
