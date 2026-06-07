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
  type UsedeskChatOptions,
} from "./client.js";
import type { ChatMessage } from "./protocol.js";

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
      error: null,
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
      replace({ status: "idle", messages: [], hasIdentity: false });
    },

    dispose: () => {
      client.dispose();
      replace({ status: "idle", connected: false });
    },

    client,
  };
};
