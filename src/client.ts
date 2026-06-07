/**
 * UsedeskChatClient — framework-agnostic client for the Usedesk chat socket
 * (protocol: `src/protocol.ts`, transport: socket.io v4, single `dispatch`
 * event both ways). Conventions: lazy connect, injectable logger, app-level keepalive,
 * reconnection left to socket.io's built-in manager.
 *
 * Lifecycle: `connect()` opens the socket and sends INIT (with the persisted
 * token when present — resuming the existing conversation). The server replies
 * INITED with the token + client state; the token is persisted immediately.
 * `dispose()` tears everything down.
 */

import { cachedDiscoverConfig } from "./discovery.js";
import type {
  ChatClientEvent,
  ChatMessage,
  ChatServerAction,
  ChatUserData,
  InitedEvent,
} from "./protocol.js";
import { clearToken, getStoredToken, storeToken } from "./token-store.js";
import {
  socketIoTransport,
  type ChatTransport,
  type TransportFactory,
} from "./transport.js";

export interface UsedeskChatLogger {
  // eslint-disable-next-line no-unused-vars
  log(event: string, data?: Record<string, unknown>): void;
  // eslint-disable-next-line no-unused-vars
  warn(event: string, data?: Record<string, unknown>): void;
  // eslint-disable-next-line no-unused-vars
  error(event: string, data?: Record<string, unknown>): void;
}

export interface UsedeskChatOptions {
  /** Combined `<companyId>_<channelId>`, e.g. `"12345_67890"`. */
  companyId: string;
  /**
   * Account pubsub host, e.g. `"https://pubsubsec4.usedesk.ru"`. Optional
   * when `discover` is on — then it's only the fallback for a failed
   * discovery.
   */
  pubsubUrl?: string;
  /**
   * Resolve the live account config (pubsub host, REST endpoints) from the
   * tail of the public widget bundle before connecting (day-cached). Picks
   * up Usedesk-side host migrations without a redeploy.
   */
  discover?: boolean;
  /**
   * Same-origin proxy URL for discovery (REQUIRED in the browser — a direct
   * S3 fetch is CORS-blocked). Ignored unless `discover` is on.
   */
  discoverUrl?: string;
  /** REST base for file upload etc. Default: secure.usedesk.ru/uapi/v1. */
  apiDomain?: string;
  /** Wire implementation; default socket.io (see `transport.ts`). */
  transport?: TransportFactory;
  /** Debug sink; omit for silent operation. */
  logger?: UsedeskChatLogger;
  /** INIT timeout before `connect()` rejects (ms). Default 12s. */
  initTimeoutMs?: number;
}

export interface ChatIdentity {
  name?: string;
  email?: string;
  phone?: string;
  additionalFields?: Array<{ id: number; value: string | number | boolean }>;
}

export interface ChatState {
  token: string;
  chatId: number;
  clientEmail: string | null;
  clientName: string | null;
  messages: ChatMessage[];
}

interface ChatEvents {
  /** INIT acked; payload carries the (possibly restored) history. */
  inited: ChatState;
  /** A message was added to the conversation (incl. echo of our own). */
  message: ChatMessage;
  /** Older history page prepended (GET_MESSAGES response). */
  olderMessages: ChatMessage[];
  /** Operators' online status changed. */
  operatorsStatus: unknown;
  /** Transport-or-protocol level problem (socket error / @@redbone/ERROR). */
  error: { code: string; message: string };
  /** Socket connectivity changed. */
  connection: { connected: boolean };
}

type Handler<T> = (payload: T) => void;

const DEFAULT_API_DOMAIN = "https://secure.usedesk.ru/uapi/v1";
const PULSE_INTERVAL_MS = 20_000; // official widget cadence
const DEFAULT_INIT_TIMEOUT_MS = 12_000;

/** Messages the chat UI renders, with empty service entries filtered out. */
export const isRenderableMessage = (m: ChatMessage): boolean =>
  Boolean((m.text && m.text.trim()) || m.file);

export class UsedeskChatClient {
  private options: UsedeskChatOptions;
  private logger: UsedeskChatLogger | null;
  private transport: ChatTransport | null = null;
  /** REST base — may be refined by discovery before the first connect. */
  private apiDomain: string;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: { [K in keyof ChatEvents]?: Set<Handler<ChatEvents[K]>> } =
    {};
  private state: ChatState | null = null;
  private connectPromise: Promise<ChatState> | null = null;

  constructor(options: UsedeskChatOptions) {
    this.options = options;
    this.apiDomain = options.apiDomain ?? DEFAULT_API_DOMAIN;
    this.logger = options.logger ?? null;
  }

  /** Persisted chat session exists → open the chat view directly. */
  get hasIdentity(): boolean {
    return Boolean(getStoredToken());
  }

  /** Current token (after connect, or persisted from a previous session). */
  get token(): string | null {
    return this.state?.token ?? getStoredToken();
  }

  get chatState(): ChatState | null {
    return this.state;
  }

  on<K extends keyof ChatEvents>(
    event: K,
    handler: Handler<ChatEvents[K]>,
  ): () => void {
    let bag = this.handlers[event] as Set<Handler<ChatEvents[K]>> | undefined;
    if (!bag) {
      bag = new Set();
      (this.handlers as Record<K, Set<Handler<ChatEvents[K]>>>)[event] = bag;
    }
    bag.add(handler);
    return () => bag!.delete(handler);
  }

  private emit<K extends keyof ChatEvents>(
    event: K,
    payload: ChatEvents[K],
  ): void {
    const bag = this.handlers[event];
    if (!bag) return;
    for (const handler of bag) {
      try {
        handler(payload);
      } catch (err) {
        this.logger?.error("handler_error", {
          event,
          message: String((err as Error)?.message || err),
        });
      }
    }
  }

  /**
   * Open the wire and INIT the chat (resuming via the stored token when
   * present). With `discover` on, the live account config is resolved first
   * (host migrations / endpoint changes picked up automatically). Resolves
   * with the chat state once INITED arrives; rejects on timeout / transport
   * failure — callers use that to fall back to the official script widget.
   * Idempotent while pending/connected.
   */
  connect(): Promise<ChatState> {
    if (this.state && this.transport?.connected)
      return Promise.resolve(this.state);
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.establish().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async establish(): Promise<ChatState> {
    const pubsubUrl = await this.resolvePubsubUrl();

    return new Promise<ChatState>((resolve, reject) => {
      // Don't reject after a successful INIT: later transport errors are the
      // reconnect manager's business and only get logged.
      let settled = false;

      const initTimeout = setTimeout(() => {
        this.logger?.warn("init_timeout");
        settled = true;
        this.dispose();
        reject(new Error("usedesk_chat_init_timeout"));
      }, this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);

      const factory = this.options.transport ?? socketIoTransport;
      this.transport = factory(pubsubUrl, {
        onConnect: () => {
          this.logger?.log("connected", { url: pubsubUrl });
          this.emit("connection", { connected: true });
          this.sendInit(); // also re-INITs after every transport reconnect
        },
        onAction: (action) => {
          this.onAction(action as ChatClientEvent, (state) => {
            if (settled) return;
            settled = true;
            clearTimeout(initTimeout);
            resolve(state);
          });
        },
        onDisconnect: (reason) => {
          this.logger?.warn("disconnected", { reason });
          this.stopPulse();
          this.emit("connection", { connected: false });
        },
        onError: (message) => {
          this.logger?.warn("connect_error", { message });
          if (settled) return;
          settled = true;
          clearTimeout(initTimeout);
          this.dispose();
          reject(new Error(`usedesk_chat_connect_error: ${message}`));
        },
      });
      this.transport.connect();
    });
  }

  /** options.pubsubUrl, refined by (day-cached) discovery when enabled. */
  private async resolvePubsubUrl(): Promise<string> {
    let pubsubUrl = this.options.pubsubUrl;
    if (this.options.discover) {
      const config = await cachedDiscoverConfig(this.options.companyId, {
        url: this.options.discoverUrl,
      });
      if (config?.pubsubUrl) pubsubUrl = config.pubsubUrl;
      if (config?.apiDomain && !this.options.apiDomain) {
        this.apiDomain = config.apiDomain;
      }
      if (config?.centrifugoEnabled && !this.options.transport) {
        // Interface is ready but the second transport isn't shipped yet —
        // surface loudly so the consumer's fallback path kicks in on failure.
        this.logger?.warn("centrifugo_enabled_unsupported", {
          host: config.centrifugoConnectionHost ?? "",
        });
      }
      this.logger?.log("discovery", { pubsubUrl: pubsubUrl ?? "" });
    }
    if (!pubsubUrl) throw new Error("usedesk_chat_no_pubsub_url");
    return pubsubUrl;
  }

  /** Identify the visitor (pre-chat form or a logged-in user's profile). */
  setClient(identity: ChatIdentity): void {
    const token = this.state?.token;
    if (!token) {
      this.logger?.warn("set_client_before_inited");
      return;
    }
    this.send({
      type: "@@server/chat/SET_CLIENT",
      payload: {
        token,
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.name ? { username: identity.name } : {}),
        ...(identity.phone ? { phone: identity.phone } : {}),
        ...(identity.additionalFields?.length
          ? { additional_fields: identity.additionalFields }
          : {}),
      },
    });
  }

  sendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.send({ type: "@@server/chat/SEND_MESSAGE", message: { text: trimmed } });
  }

  /** Request an older history page (prepended via the `olderMessages` event). */
  loadOlder(beforeMessageId: number, limit = 40): void {
    this.send({
      type: "@@server/chat/GET_MESSAGES",
      lt_id: beforeMessageId,
      limit,
    });
  }

  /**
   * Upload a file into the conversation. Two steps, as in the official
   * widget: the binary goes to REST `POST <apiDomain>/safely_send_file`
   * (form_data: `signature` = btoa(full companyId), `chat_token`, `file`;
   * 15 MiB widget-side limit) which returns `{file_link}`, then the link is
   * announced on the socket via SEND_MESSAGE — the server echoes it back as
   * an ADD_MESSAGE.
   */
  async sendFile(file: File): Promise<void> {
    const token = this.state?.token;
    if (!token) throw new Error("usedesk_chat_not_inited");
    const form = new FormData();
    form.append("signature", btoa(this.options.companyId));
    form.append("chat_token", token);
    form.append("file", file);
    const res = await fetch(`${this.apiDomain}/safely_send_file`, {
      method: "POST",
      body: form,
    });
    const data = (await res.json().catch(() => null)) as {
      file_link?: string;
      error?: string;
    } | null;
    if (!res.ok || !data?.file_link) {
      this.logger?.error("send_file_failed", {
        status: res.status,
        error: data?.error ?? "",
      });
      throw new Error(`usedesk_chat_send_file_failed: ${res.status}`);
    }
    this.send({
      type: "@@server/chat/SEND_MESSAGE",
      message: {
        text: "",
        file: {
          name: file.name,
          type: file.type,
          content: data.file_link,
          size: humanFileSize(file.size),
        },
        fileUploadType: true,
      },
    });
    // The server echoes the attachment back as a regular ADD_MESSAGE
    // (with previewLink/download links), so no optimistic local message.
  }

  /** Drop the persisted session (e.g. on logout, to avoid merging clients). */
  resetSession(): void {
    clearToken();
    this.state = null;
  }

  dispose(): void {
    this.stopPulse();
    if (this.transport) {
      try {
        this.transport.disconnect();
      } catch {
        // noop
      }
      this.transport = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private sendInit(): void {
    const token = getStoredToken();
    const action: ChatServerAction = {
      type: "@@server/chat/INIT",
      company_id: this.options.companyId,
      url: typeof window !== "undefined" ? window.location.href : "",
      payload: { userData: buildUserData() },
      ...(token ? { token } : {}),
    };
    this.send(action);
  }

  private onAction(
    action: ChatClientEvent,
    onInited: (state: ChatState) => void,
  ): void {
    switch (action?.type) {
      case "@@chat/current/INITED": {
        this.state = stateFromInited(action);
        storeToken(this.state.token);
        this.startPulse();
        this.logger?.log("inited", {
          chat: this.state.chatId,
          messages: this.state.messages.length,
        });
        this.emit("inited", this.state);
        onInited(this.state);
        return;
      }
      case "@@chat/current/ADD_MESSAGE": {
        if (!action.message || !isRenderableMessage(action.message)) return;
        this.state?.messages.push(action.message);
        this.emit("message", action.message);
        return;
      }
      case "@@chat/current/PUSH_MESSAGES": {
        const fresh = (action.messages ?? []).filter(isRenderableMessage);
        if (!fresh.length) return;
        this.state?.messages.push(...fresh);
        for (const m of fresh) this.emit("message", m);
        return;
      }
      case "@@chat/current/UNSHIFT_MESSAGES": {
        const older = (action.messages ?? []).filter(isRenderableMessage);
        this.state?.messages.unshift(...older);
        this.emit("olderMessages", older);
        return;
      }
      case "@@chat/current/SET": {
        if (!this.state || !action.state?.client) return;
        const { client } = action.state;
        this.state.clientEmail = client.email ?? this.state.clientEmail;
        this.state.clientName = client.name ?? this.state.clientName;
        return;
      }
      case "@@chat/current/CHANGE_OPERATORS_STATUS": {
        this.emit("operatorsStatus", action.newStatus);
        return;
      }
      case "@@chat/current/TO_RELOAD_CHAT": {
        // Session restart requested (token rotation) — re-INIT with the new token.
        this.logger?.log("to_reload_chat");
        if (action.token) storeToken(action.token);
        this.sendInit();
        return;
      }
      case "@@redbone/ERROR": {
        this.logger?.error("server_error", {
          code: action.code,
          message: action.message,
        });
        this.emit("error", {
          code: String(action.code),
          message: action.message,
        });
        return;
      }
      default:
        this.logger?.log("unhandled_action", {
          type: (action as { type?: string })?.type ?? "unknown",
        });
    }
  }

  private send(action: ChatServerAction): void {
    try {
      const sent = this.transport?.send(action) ?? false;
      if (!sent) this.logger?.warn("send_skipped_disconnected");
    } catch (err) {
      this.logger?.error("send_error", {
        message: String((err as Error)?.message || err),
      });
    }
  }

  private startPulse(): void {
    this.stopPulse();
    this.pulseTimer = setInterval(() => {
      const token = this.state?.token;
      if (!token) return;
      this.send({
        type: "@@server/chat/PULSE_ACTION",
        timestamp: Date.now() / 1000,
        token,
      });
    }, PULSE_INTERVAL_MS);
  }

  private stopPulse(): void {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }
}

const stateFromInited = (event: InitedEvent): ChatState => {
  const setup = event.setup ?? ({} as InitedEvent["setup"]);
  const client = setup.client;
  const messages = (setup.messages ?? client?.messages ?? []).filter(
    isRenderableMessage,
  );
  return {
    token: event.token,
    chatId: client?.chat ?? 0,
    clientEmail: client?.email ?? null,
    clientName: client?.name ?? null,
    messages,
  };
};

/**
 * Browser facts the server requires in INIT (rejects an empty userData).
 * The official widget resolves the IP via api.usedesk.ru/ip; the server
 * sees the real connection IP anyway, so we don't spend a request on it.
 */
const buildUserData = (): ChatUserData => {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const ua = nav?.userAgent ?? "";
  return {
    userAgent: ua,
    ip: "",
    pageUrl: typeof window !== "undefined" ? window.location.href : "",
    os: detectOs(ua),
    browserName: detectBrowser(ua),
    browserVersion: "",
    defaultMessageOfOperator: "",
  };
};

const detectOs = (ua: string): string => {
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X/i.test(ua)) return "OS X";
  if (/Linux/i.test(ua)) return "Linux";
  return "";
};

/** Mirrors the widget's bytesToSize — the size travels as a display string. */
const humanFileSize = (bytes: number): string => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

const detectBrowser = (ua: string): string => {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return "Safari";
  if (/Firefox\//i.test(ua)) return "Firefox";
  return "";
};

export const createUsedeskChat = (options: UsedeskChatOptions) =>
  new UsedeskChatClient(options);
