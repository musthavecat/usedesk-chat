/**
 * Headless chat store — the universal binding surface for any UI layer.
 * Wraps UsedeskChatClient into the external-store contract every framework
 * can consume: `getSnapshot()` returns an IMMUTABLE state object (replaced
 * wholesale on every change, never mutated), `subscribe()` notifies on each
 * replacement. React binds via useSyncExternalStore (`./react`), Vue via a
 * shallowRef (`./vue`), vanilla JS subscribes directly.
 */

import {
  UsedeskChatClient,
  type ChatIdentity,
  type FilledFormField,
  type FormFieldDefinition,
  type FormSubmitField,
  type OfflineFormParams,
  type UsedeskChatOptions,
} from "./client.js";
import type { ChatMessage, ChatMessageButton } from "./protocol.js";

export type ChatStatus = "idle" | "connecting" | "ready" | "error";

export interface ChatSnapshot {
  status: ChatStatus;
  /** Renderable conversation history, oldest first. */
  messages: ChatMessage[];
  /** A persisted chat session exists (token in cookie/localStorage). */
  hasIdentity: boolean;
  /** Raw CHANGE_OPERATORS_STATUS payload; shape is account-specific. */
  operatorsStatus: unknown;
  /** Socket connectivity (false while idle/reconnecting). */
  connected: boolean;
  /** No operators online → show the offline form instead of live chat. */
  noOperators: boolean;
  /** Offline-form / callback config from INITED (account-specific shape). */
  callbackSettings: Record<string, unknown> | null;
  /** Per-message CSAT choice, keyed by message id (optimistic). */
  feedback: Record<number, "like" | "dislike">;
  /** Last transport/protocol error, cleared on the next successful connect. */
  error: { code: string; message: string } | null;
}

export interface ChatStore {
  getSnapshot(): ChatSnapshot;
  /** Called after every snapshot replacement. Returns an unsubscribe fn. */
  // eslint-disable-next-line no-unused-vars
  subscribe(onChange: () => void): () => void;

  /** Open the socket + INIT. Resolves false on failure (fallback hook). */
  connect(): Promise<boolean>;
  // eslint-disable-next-line no-unused-vars
  send(text: string): void;
  // eslint-disable-next-line no-unused-vars
  sendFile(file: File): Promise<void>;
  // eslint-disable-next-line no-unused-vars
  setClient(identity: ChatIdentity): void;
  /** Send CSAT feedback (👍/👎) for an operator/bot message. */
  // eslint-disable-next-line no-unused-vars
  sendFeedback(messageId: number, liked: boolean): void;
  /** Act on an inline message button (returns a URL for link buttons). */
  // eslint-disable-next-line no-unused-vars
  clickButton(button: ChatMessageButton): string | null;
  /** Submit the offline/contact form (no operators online). */
  // eslint-disable-next-line no-unused-vars
  sendOfflineForm(params: OfflineFormParams): Promise<void>;
  /** Submit a bot lead-form via SET_CLIENT (quick shortcut, built-in fields). */
  // eslint-disable-next-line no-unused-vars
  submitForm(filled: FilledFormField[]): void;
  /** Fetch custom-field definitions for a bot form (input type + options). */
  // eslint-disable-next-line no-unused-vars
  fetchFormFields(fieldIds: number[]): Promise<FormFieldDefinition[]>;
  /** Submit a bot form to the official `custom_form/save` endpoint. */
  // eslint-disable-next-line no-unused-vars
  submitFormMessage(fields: FormSubmitField[]): Promise<void>;
  /** Attach custom ticket fields to the chat (addFieldsToChat REST flow). */
  sendAdditionalFields(
    // eslint-disable-next-line no-unused-vars
    fields: Array<{ id: number; value: string | number | boolean }>,
    // eslint-disable-next-line no-unused-vars
    nested?: Array<Array<{ id: number; value: string | number | boolean }>>,
  ): Promise<void>;
  /** Upload the visitor's avatar (multipart). */
  sendAvatar(
    // eslint-disable-next-line no-unused-vars
    avatar: Blob,
    // eslint-disable-next-line no-unused-vars
    identity?: { email?: string; phone?: string; name?: string },
  ): Promise<void>;
  /** Re-send a `failed` optimistic message (requires `optimistic: true`). */
  // eslint-disable-next-line no-unused-vars
  retry(localId: string): void;
  /** Request the next older history page (no-op until messages exist). */
  loadOlder(limit?: number): void;
  /** Re-read the persisted token (e.g. before deciding form vs chat). */
  checkIdentity(): boolean;
  /** Drop the persisted session (logout) — prevents client merging. */
  resetSession(): void;
  dispose(): void;

  /** Escape hatch to the underlying client (events, logger, raw state). */
  client: UsedeskChatClient;
}

export const createChatStore = (options: UsedeskChatOptions): ChatStore => {
  const client = new UsedeskChatClient(options);
  const listeners = new Set<() => void>();

  let snapshot: ChatSnapshot = {
    status: "idle",
    messages: [],
    hasIdentity: client.hasIdentity,
    operatorsStatus: null,
    connected: false,
    noOperators: false,
    callbackSettings: null,
    feedback: {},
    error: null,
  };

  const replace = (patch: Partial<ChatSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  client.on("inited", (state) => {
    replace({
      status: "ready",
      messages: [...state.messages],
      hasIdentity: true,
      noOperators: state.noOperators,
      callbackSettings: state.callbackSettings,
      error: null,
    });
  });
  client.on("feedback", ({ messageId, liked }) => {
    replace({
      feedback: { ...snapshot.feedback, [messageId]: liked ? "like" : "dislike" },
    });
  });
  client.on("message", (m) => {
    replace({ messages: [...snapshot.messages, m] });
  });
  client.on("olderMessages", (older) => {
    replace({ messages: [...older, ...snapshot.messages] });
  });
  client.on("operatorsStatus", (operatorsStatus) => {
    replace({ operatorsStatus });
  });
  client.on("connection", ({ connected }) => {
    replace({ connected });
  });
  client.on("error", (error) => {
    replace({ error });
  });
  client.on("messageUpdate", ({ localId, message }) => {
    replace({
      messages: snapshot.messages.map((m) =>
        m.localId === localId ? message : m,
      ),
    });
  });

  let connecting: Promise<boolean> | null = null;

  return {
    getSnapshot: () => snapshot,

    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },

    connect: () => {
      if (snapshot.status === "ready") return Promise.resolve(true);
      if (connecting) return connecting;
      replace({ status: "connecting" });
      connecting = client
        .connect()
        .then(() => true) // snapshot flips to "ready" in the inited handler
        .catch(() => {
          replace({ status: "error" });
          return false;
        })
        .finally(() => {
          connecting = null;
        });
      return connecting;
    },

    send: (text) => client.sendMessage(text),
    sendFile: (file) => client.sendFile(file),
    setClient: (identity) => client.setClient(identity),
    sendFeedback: (messageId, liked) => client.sendFeedback(messageId, liked),
    clickButton: (button) => client.clickButton(button),
    sendOfflineForm: (params) => client.sendOfflineForm(params),
    submitForm: (filled) => client.submitForm(filled),
    fetchFormFields: (fieldIds) => client.fetchFormFields(fieldIds),
    submitFormMessage: (fields) => client.submitFormMessage(fields),
    sendAdditionalFields: (fields, nested) =>
      client.sendAdditionalFields(fields, nested),
    sendAvatar: (avatar, identity) => client.sendAvatar(avatar, identity),
    retry: (localId) => client.retry(localId),

    loadOlder: (limit) => {
      const first = snapshot.messages[0];
      if (first && first.id > 0) client.loadOlder(first.id, limit);
    },

    checkIdentity: () => {
      const hasIdentity = client.hasIdentity;
      if (hasIdentity !== snapshot.hasIdentity) replace({ hasIdentity });
      return hasIdentity;
    },

    resetSession: () => {
      client.resetSession();
      replace({
        status: "idle",
        messages: [],
        hasIdentity: false,
        noOperators: false,
        callbackSettings: null,
        feedback: {},
      });
    },

    dispose: () => {
      client.dispose();
      replace({ status: "idle", connected: false });
    },

    client,
  };
};
