/**
 * Shared test doubles: a fake transport (capture sent actions, inject server
 * actions), DOM storage stubs (localStorage + document.cookie), and a fetch
 * mock. All pure in-memory — no socket, no network.
 */

import type {
  ChatTransport,
  TransportFactory,
  TransportHandlers,
} from "../src/transport.js";

export const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export interface FakeTransport {
  factory: TransportFactory;
  sent: Array<Record<string, unknown>>;
  emit(action: unknown): void;
  error(message: string): void;
  disconnect(reason?: string): void;
  reconnect(): void;
  readonly connected: boolean;
}

export function makeFakeTransport(): FakeTransport {
  const sent: Array<Record<string, unknown>> = [];
  let handlers: TransportHandlers | null = null;
  let connected = false;
  const factory: TransportFactory = (_url, h) => {
    handlers = h;
    const transport: ChatTransport = {
      connect() {
        connected = true;
        h.onConnect();
      },
      disconnect() {
        connected = false;
      },
      send(action) {
        if (!connected) return false;
        sent.push(action as Record<string, unknown>);
        return true;
      },
      get connected() {
        return connected;
      },
    };
    return transport;
  };
  return {
    factory,
    sent,
    emit: (action) => handlers?.onAction(action),
    error: (message) => handlers?.onError(message),
    disconnect: (reason = "io client disconnect") => {
      connected = false;
      handlers?.onDisconnect(reason);
    },
    reconnect: () => {
      connected = true;
      handlers?.onConnect();
    },
    get connected() {
      return connected;
    },
  };
}

export function installStorage(): { getCookie: () => string } {
  const ls = new Map<string, string>();
  let cookie = "";
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k: string, v: string) => {
      ls.set(k, v);
    },
    removeItem: (k: string) => {
      ls.delete(k);
    },
    clear: () => ls.clear(),
  };
  (globalThis as Record<string, unknown>).document = {
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      const pair = value.split(";")[0] ?? "";
      const key = pair.split("=")[0] ?? "";
      const others = cookie
        .split("; ")
        .filter((c) => c && !c.startsWith(`${key}=`));
      if (value.includes("01 Jan 1970")) {
        cookie = others.join("; ");
      } else {
        cookie = [...others, pair].join("; ");
      }
    },
  };
  return { getCookie: () => cookie };
}

export interface FetchMock {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  setResponder(
    // eslint-disable-next-line no-unused-vars
    fn: (
      // eslint-disable-next-line no-unused-vars
      url: string,
      // eslint-disable-next-line no-unused-vars
      init: RequestInit | undefined,
    ) => {
      ok?: boolean;
      status?: number;
      json?: unknown;
      text?: string;
    },
  ): void;
}

export function mockFetch(): FetchMock {
  const calls: FetchMock["calls"] = [];
  let responder: Parameters<FetchMock["setResponder"]>[0] = () => ({
    ok: true,
    json: {},
  });
  (globalThis as Record<string, unknown>).fetch = async (
    url: string,
    init: RequestInit | undefined,
  ) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url), init);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? null,
      text: async () => r.text ?? "",
    };
  };
  return {
    calls,
    setResponder: (fn) => {
      responder = fn;
    },
  };
}

/** A minimal INITED server action with overridable setup fields. */
export const initedAction = (over: Record<string, unknown> = {}) => ({
  type: "@@chat/current/INITED",
  token: "tok-1",
  setup: {
    client: { chat: 99, email: null, name: null, pic: null },
    waitingEmail: false,
    messages: [],
    token: "tok-1",
    ...over,
  },
});

/** A minimal ADD_MESSAGE server action. */
export const addMessageAction = (over: Record<string, unknown> = {}) => ({
  type: "@@chat/current/ADD_MESSAGE",
  message: {
    id: 1,
    text: "hi",
    createdAt: "2026-01-01T00:00:00Z",
    chat: 99,
    type: "operator_to_client",
    name: "Op",
    ...over,
  },
});
