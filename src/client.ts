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

import { hasButtonMarkup, parseButtonsMessage } from "./buttons.js";
import { cachedDiscoverConfig } from "./discovery.js";
import { hasFormMarkup, parseFormMessage } from "./forms.js";
import type {
  ChatClientEvent,
  ChatMessage,
  ChatMessageButton,
  ChatMessageFormField,
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
  /**
   * REST endpoint for the offline/contact form (used when no operators are
   * online). Default: secure.usedesk.ru/widget.js/post.
   */
  offlineFormUrl?: string;
  /** REST endpoint for visitor-avatar upload. Default: derived from apiDomain. */
  avatarUrl?: string;
  /**
   * Auto-sent once, on the first INITED of a brand-new chat (empty history) —
   * the official widget's `firstMessage`. Omit to send nothing.
   */
  firstMessage?: string;
  /**
   * Optimistic send: outgoing messages render immediately with a `sending`
   * status, reconcile on the server echo (matched by `payload.message_id`),
   * and flip to `failed` when the socket is down — retry via `retry(localId)`.
   * Off by default; reconciliation depends on the server echoing message_id.
   */
  optimistic?: boolean;
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
  /** Free-text note attached to the ticket/client. */
  note?: string;
  /** Stable external customer id — the cross-device identify key. */
  additionalId?: string;
  additionalFields?: Array<{ id: number; value: string | number | boolean }>;
}

/** A bot form field (from `message.forms`) paired with the user's input. */
export interface FilledFormField {
  field: ChatMessageFormField;
  value: string;
}

/** Input kind of a custom ticket field (from `field_list`). */
export type FormFieldInputType = "text" | "select" | "checkbox";

/** A selectable option of a `select` custom field. */
export interface FormFieldOption {
  id: number;
  value: string;
  /** Parent option ids for cascading (parent→child) selects, when present. */
  parentOptionIds?: number[];
}

/** Definition of a custom ticket field, fetched via `fetchFormFields`. */
export interface FormFieldDefinition {
  id: number;
  name: string;
  inputType: FormFieldInputType;
  value?: string;
  parentFieldId?: number;
  options: FormFieldOption[];
}

/** A bot-form field paired with the user's value, for `submitFormMessage`. */
export interface FormSubmitField {
  field: ChatMessageFormField;
  /** Entered value; booleans → "true"/"false", numbers/option-ids → string. */
  value: string | number | boolean;
  /** Override the label sent to Usedesk (defaults to `field.name`). */
  label?: string;
}

/** Offline/contact-form submission (no operators online). */
export interface OfflineFormParams {
  name?: string;
  email?: string;
  message: string;
  /** Selected topic, when the account's callback settings require one. */
  topic?: string;
  /** Extra callback custom fields, keyed by the field key. */
  fields?: Record<string, string>;
}

export interface ChatState {
  token: string;
  chatId: number;
  clientEmail: string | null;
  clientName: string | null;
  /** No operators online → the offline-form path (from INITED). */
  noOperators: boolean;
  /** Offline-form / callback config from INITED (account-specific shape). */
  callbackSettings: Record<string, unknown> | null;
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
  /** We sent CSAT feedback for a message (optimistic echo of our choice). */
  feedback: { messageId: number; liked: boolean };
  /** Server acked a feedback CALLBACK (status = accepted). */
  feedbackAnswer: { status: boolean };
  /** An optimistic message changed in place (echo reconciled / failed / retried). */
  messageUpdate: { localId: string; message: ChatMessage };
}

type Handler<T> = (payload: T) => void;

const DEFAULT_API_DOMAIN = "https://secure.usedesk.ru/uapi/v1";
const DEFAULT_OFFLINE_FORM_URL = "https://secure.usedesk.ru/widget.js/post";
const PULSE_INTERVAL_MS = 20_000; // official widget cadence
const DEFAULT_INIT_TIMEOUT_MS = 12_000;

/** Messages the chat UI renders, with empty service entries filtered out. */
export const isRenderableMessage = (m: ChatMessage): boolean =>
  Boolean((m.text && m.text.trim()) || m.file || m.forms?.length);

/**
 * Decode `{{button:…}}` and `{{form;…}}` markup out of a message's text into
 * structured `buttons` / `forms`, and lift the CSAT feedback markers off the
 * payload (`csi` = a rating is requested, `userRating` = already rated).
 */
const normalizeMessage = (m: ChatMessage): ChatMessage => {
  let text = m.text ?? "";
  if (hasButtonMarkup(text)) {
    const parsed = parseButtonsMessage(text);
    text = parsed.text;
    if (parsed.buttons.length) m.buttons = parsed.buttons;
  }
  if (hasFormMarkup(text)) {
    const parsed = parseFormMessage(text);
    text = parsed.text;
    if (parsed.forms.length) m.forms = parsed.forms;
  }
  m.text = text;

  const payload = m.payload as Record<string, unknown> | null | undefined;
  if (payload) {
    if (payload.csi != null) m.feedbackRequested = true;
    if (payload.userRating === "LIKE") {
      m.feedbackRequested = true;
      m.feedbackRating = "like";
    } else if (payload.userRating === "DISLIKE") {
      m.feedbackRequested = true;
      m.feedbackRating = "dislike";
    }
  }
  return m;
};

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
  private firstMessageSent = false;
  /** Optimistic messages awaiting their server echo, keyed by local id. */
  private pending = new Map<string, ChatMessage>();
  private localSeq = 0;

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
        ...(identity.note ? { note: identity.note } : {}),
        ...(identity.additionalId ? { additional_id: identity.additionalId } : {}),
        ...(identity.additionalFields?.length
          ? { additional_fields: identity.additionalFields }
          : {}),
      },
    });
  }

  /**
   * Send CSAT feedback (👍/👎) for an operator/bot message — a `CALLBACK`
   * action. Fire-and-forget: the server acks with CALLBACK_ANSWER (surfaced
   * via the `feedbackAnswer` event) but the ack carries no message id, so the
   * UI tracks the choice optimistically off the `feedback` event.
   */
  sendFeedback(messageId: number, liked: boolean): void {
    this.send({
      type: "@@server/chat/CALLBACK",
      payload: {
        data: liked ? "LIKE" : "DISLIKE",
        type: "action",
        messageId: String(messageId),
      },
    });
    this.emit("feedback", { messageId, liked });
  }

  /**
   * Act on an inline message button. Link buttons (with a `url`) return the
   * URL for the caller to open; reply buttons send their `title` back as a
   * regular message and return null.
   */
  clickButton(button: ChatMessageButton): string | null {
    if (button.url) return button.url;
    this.sendMessage(button.title);
    return null;
  }

  /**
   * Submit a bot lead-form (the fields decoded into `message.forms`). Maps each
   * filled field to the matching client attribute and identifies the visitor
   * via SET_CLIENT — what the official widget does on form submit. Unmapped
   * types (e.g. `position`) are ignored.
   */
  submitForm(filled: FilledFormField[]): void {
    const identity: ChatIdentity = {};
    const additionalFields: Array<{ id: number; value: string }> = [];
    for (const { field, value } of filled) {
      switch (field.type) {
        case "email":
          identity.email = value;
          break;
        case "phone":
          identity.phone = value;
          break;
        case "name":
          identity.name = value;
          break;
        case "note":
          identity.note = value;
          break;
        case "additionalField":
          if (field.fieldId !== undefined) {
            additionalFields.push({ id: field.fieldId, value });
          }
          break;
        default:
          break; // `position` — no SET_CLIENT field
      }
    }
    if (additionalFields.length) identity.additionalFields = additionalFields;
    this.setClient(identity);
  }

  /**
   * Fetch the definitions (input type + options) of a bot form's custom fields
   * so they can be rendered as text inputs / checkboxes / dropdowns. POSTs the
   * `additionalField` ids (from `message.forms`) to `/v1/widget/field_list`.
   * Returns `[]` when there are no custom fields.
   */
  async fetchFormFields(fieldIds: number[]): Promise<FormFieldDefinition[]> {
    const token = this.state?.token;
    if (!token) throw new Error("usedesk_chat_not_inited");
    const ids = fieldIds.filter((id) => id > 0);
    if (!ids.length) return [];
    const res = await fetch(`${widgetHost(this.apiDomain)}/v1/widget/field_list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: token, ids: ids.join(",") }),
    });
    const data = (await res.json().catch(() => null)) as {
      fields?: Record<string, unknown>;
    } | null;
    if (!res.ok || !data) {
      this.logger?.error("field_list_failed", { status: res.status });
      throw new Error(`usedesk_chat_field_list_failed: ${res.status}`);
    }
    return parseFieldList(data.fields ?? {});
  }

  /**
   * Submit a bot lead-form to the official endpoint (`/v1/widget/custom_form/save`)
   * — the correct, complete form submission (vs the `submitForm` → SET_CLIENT
   * shortcut). Built-in fields go by their associate type, custom fields by
   * their numeric id; checkbox values are normalised to "true"/"false" and
   * select values pass the chosen option id. (Cascading parent→child selects
   * aren't grouped — pass the leaf option id.)
   */
  async submitFormMessage(fields: FormSubmitField[]): Promise<void> {
    const token = this.state?.token;
    if (!token) throw new Error("usedesk_chat_not_inited");
    const form = fields.map(({ field, value, label }) => {
      const v =
        typeof value === "boolean" ? (value ? "true" : "false") : String(value);
      const name = label ?? field.name;
      return field.type === "additionalField" && field.fieldId !== undefined
        ? { associate: field.fieldId, value: v, label: name }
        : { associate: field.type, required: field.required, value: v, label: name };
    });
    const res = await fetch(
      `${widgetHost(this.apiDomain)}/v1/widget/custom_form/save`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: token, form }),
      },
    );
    if (!res.ok) {
      this.logger?.error("custom_form_save_failed", { status: res.status });
      throw new Error(`usedesk_chat_custom_form_save_failed: ${res.status}`);
    }
  }

  /**
   * Submit the offline/contact form — used when no operators are online
   * (`chatState.noOperators`). REST POST to the widget endpoint, mirroring the
   * official widget: `{company_id, name, email, message, userData, topic?,
   * …fields}`. Independent of the socket; works even before/without connect().
   */
  async sendOfflineForm(params: OfflineFormParams): Promise<void> {
    const url = this.options.offlineFormUrl ?? DEFAULT_OFFLINE_FORM_URL;
    const body: Record<string, unknown> = {
      company_id: this.options.companyId,
      message: params.message,
      name: params.name ?? "",
      email: params.email ?? "",
      userData: offlineUserData(),
    };
    if (params.topic) body.topic = params.topic;
    if (params.fields) Object.assign(body, params.fields);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.logger?.error("offline_form_failed", { status: res.status });
      throw new Error(`usedesk_chat_offline_form_failed: ${res.status}`);
    }
  }

  sendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.options.optimistic) {
      this.send({
        type: "@@server/chat/SEND_MESSAGE",
        message: { text: trimmed },
      });
      return;
    }
    // Optimistic: render now, reconcile on the echo (matched by message_id).
    this.localSeq += 1;
    const localId = `local-${this.localSeq}`;
    const optimistic: ChatMessage = {
      id: -this.localSeq, // negative → never collides with server ids
      text: trimmed,
      createdAt: new Date().toISOString(),
      chat: this.state?.chatId ?? null,
      type: "client_to_operator",
      name: "",
      from: "client",
      localId,
      sendStatus: "sending",
    };
    this.pending.set(localId, optimistic);
    this.state?.messages.push(optimistic);
    this.emit("message", optimistic);
    this.dispatchText(trimmed, localId);
  }

  /** Re-send a `failed` optimistic message (no-op if it isn't pending). */
  retry(localId: string): void {
    const pending = this.pending.get(localId);
    if (!pending) return;
    this.replacePending(localId, { ...pending, sendStatus: "sending" });
    this.dispatchText(pending.text, localId);
  }

  private dispatchText(text: string, localId: string): void {
    const ok = this.send({
      type: "@@server/chat/SEND_MESSAGE",
      message: { text, payload: { message_id: localId } },
    });
    if (!ok) {
      const pending = this.pending.get(localId);
      if (pending) this.replacePending(localId, { ...pending, sendStatus: "failed" });
    }
  }

  /** Keep a message in the pending map, then patch it in the history. */
  private replacePending(localId: string, message: ChatMessage): void {
    this.pending.set(localId, message);
    this.replaceByLocalId(localId, message);
  }

  /** Patch a message in the history by local id and notify the store. */
  private replaceByLocalId(localId: string, message: ChatMessage): void {
    const msgs = this.state?.messages;
    if (msgs) {
      const idx = msgs.findIndex((m) => m.localId === localId);
      if (idx >= 0) msgs[idx] = message;
    }
    this.emit("messageUpdate", { localId, message });
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

  /**
   * Attach custom ticket fields to the current chat — the official SDK's
   * `addFieldsToChat` REST flow (separate from SET_CLIENT, and the only way to
   * send nested field groups). Each field is `{ id, value }`; `nested` groups
   * are arrays of such fields.
   */
  async sendAdditionalFields(
    fields: Array<{ id: number; value: string | number | boolean }>,
    nested: Array<Array<{ id: number; value: string | number | boolean }>> = [],
  ): Promise<void> {
    const token = this.state?.token;
    if (!token) throw new Error("usedesk_chat_not_inited");
    const additional_fields: unknown[] = [...fields];
    for (const group of nested) {
      additional_fields.push(group.filter((f) => f.id > 0));
    }
    const res = await fetch(`${this.apiDomain}/addFieldsToChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_fields, chat_token: token }),
    });
    if (!res.ok) {
      this.logger?.error("add_fields_failed", { status: res.status });
      throw new Error(`usedesk_chat_add_fields_failed: ${res.status}`);
    }
  }

  /**
   * Upload the visitor's avatar (multipart) — the official SDK's avatar flow.
   * POSTs to `<host>/v1/chat/setClient` with the current token, the avatar
   * blob, and any identity fields provided.
   */
  async sendAvatar(
    avatar: Blob,
    identity: { email?: string; phone?: string; name?: string } = {},
  ): Promise<void> {
    const token = this.state?.token;
    if (!token) throw new Error("usedesk_chat_not_inited");
    const url = this.options.avatarUrl ?? avatarEndpoint(this.apiDomain);
    const form = new FormData();
    form.append("token", token);
    form.append("avatar", avatar, "avatar");
    form.append("company_id", this.options.companyId);
    if (identity.email) form.append("email", identity.email);
    if (identity.phone) form.append("phone", identity.phone);
    if (identity.name) form.append("username", identity.name);
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) {
      this.logger?.error("avatar_failed", { status: res.status });
      throw new Error(`usedesk_chat_avatar_failed: ${res.status}`);
    }
  }

  /** Drop the persisted session (e.g. on logout, to avoid merging clients). */
  resetSession(): void {
    clearToken();
    this.state = null;
    this.pending.clear();
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
        if (
          this.options.firstMessage &&
          !this.firstMessageSent &&
          this.state.messages.length === 0
        ) {
          this.firstMessageSent = true;
          this.sendMessage(this.options.firstMessage);
        }
        return;
      }
      case "@@chat/current/ADD_MESSAGE": {
        if (!action.message) return;
        const message = normalizeMessage(action.message);
        // Echo of one of our optimistic messages → reconcile, don't append.
        const echoedId = (
          message.payload as { message_id?: unknown } | null | undefined
        )?.message_id;
        if (typeof echoedId === "string" && this.pending.has(echoedId)) {
          this.pending.delete(echoedId);
          this.replaceByLocalId(echoedId, {
            ...message,
            localId: echoedId,
            sendStatus: "sent",
          });
          return;
        }
        if (!isRenderableMessage(message)) return;
        this.state?.messages.push(message);
        this.emit("message", message);
        return;
      }
      case "@@chat/current/PUSH_MESSAGES": {
        const fresh = (action.messages ?? [])
          .map(normalizeMessage)
          .filter(isRenderableMessage);
        if (!fresh.length) return;
        this.state?.messages.push(...fresh);
        for (const m of fresh) this.emit("message", m);
        return;
      }
      case "@@chat/current/UNSHIFT_MESSAGES": {
        const older = (action.messages ?? [])
          .map(normalizeMessage)
          .filter(isRenderableMessage);
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
      case "@@chat/current/CALLBACK_ANSWER": {
        const status = Boolean(action.answer?.status);
        this.logger?.log("callback_answer", { status });
        this.emit("feedbackAnswer", { status });
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

  private send(action: ChatServerAction): boolean {
    try {
      const sent = this.transport?.send(action) ?? false;
      if (!sent) this.logger?.warn("send_skipped_disconnected");
      return sent;
    } catch (err) {
      this.logger?.error("send_error", {
        message: String((err as Error)?.message || err),
      });
      return false;
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
  const messages = (setup.messages ?? client?.messages ?? [])
    .map(normalizeMessage)
    .filter(isRenderableMessage);
  return {
    token: event.token,
    chatId: client?.chat ?? 0,
    clientEmail: client?.email ?? null,
    clientName: client?.name ?? null,
    noOperators: Boolean(setup.noOperators),
    callbackSettings: setup.callback_settings ?? null,
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

/** Origin of the widget host (drops the `/uapi/v1` path of apiDomain). */
const widgetHost = (apiDomain: string): string => {
  try {
    return new URL(apiDomain).origin;
  } catch {
    return "https://secure.usedesk.ru";
  }
};

/** Avatar-upload endpoint (`<host>/v1/chat/setClient`). */
const avatarEndpoint = (apiDomain: string): string =>
  `${widgetHost(apiDomain)}/v1/chat/setClient`;

const FIELD_INPUT_TYPE: Record<number, FormFieldInputType> = {
  1: "text",
  2: "select",
  3: "checkbox",
  4: "select",
};

const parseFieldDef = (json: Record<string, unknown>): FormFieldDefinition => {
  const options: FormFieldOption[] = [];
  const children = (json.children as Array<Record<string, unknown>>) ?? [];
  for (const child of children) {
    const parents = child.parent_option_id;
    options.push({
      id: Number(child.id),
      value: String(child.value ?? ""),
      ...(Array.isArray(parents) ? { parentOptionIds: parents as number[] } : {}),
    });
  }
  return {
    id: Number(json.id),
    name: String(json.name ?? ""),
    inputType: FIELD_INPUT_TYPE[Number(json.ticket_field_type_id)] ?? "text",
    ...(typeof json.value === "string" ? { value: json.value } : {}),
    ...(typeof json.parent_field_id === "number"
      ? { parentFieldId: json.parent_field_id }
      : {}),
    options,
  };
};

/** Parse a `/v1/widget/field_list` response (`{fields}`, with a nested `list`). */
const parseFieldList = (
  fields: Record<string, unknown>,
): FormFieldDefinition[] => {
  const out: FormFieldDefinition[] = [];
  for (const raw of Object.values(fields)) {
    const json = raw as Record<string, unknown>;
    if (json.list && typeof json.list === "object") {
      for (const sub of Object.values(json.list as Record<string, unknown>)) {
        out.push(parseFieldDef(sub as Record<string, unknown>));
      }
    } else {
      out.push(parseFieldDef(json));
    }
  }
  return out;
};

/** Minimal browser facts the offline-form endpoint records (os/browserName). */
const offlineUserData = (): Record<string, string> => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return { os: detectOs(ua), browserName: detectBrowser(ua) };
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
