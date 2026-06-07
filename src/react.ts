/**
 * React 18+ binding (`@musthavecat/usedesk-chat/react`). React is an optional
 * peer dep — only this subpath requires it.
 *
 * The store already implements React's external-store contract, so the hook
 * is a direct useSyncExternalStore call. Keep the store instance OUTSIDE the
 * component (module scope, context, or a ref) so it survives re-renders:
 *
 * ```tsx
 * const store = createChatStore({ companyId, pubsubUrl });
 *
 * function Chat() {
 *   const { messages, status } = useUsedeskChat(store);
 *   return <ul>{messages.map((m) => <li key={m.id}>{m.text}</li>)}</ul>;
 * }
 * ```
 */

import { useSyncExternalStore } from "react";
import type { ChatSnapshot, ChatStore } from "./store.js";

/** Subscribe a component to the chat snapshot (server snapshot = current). */
export const useUsedeskChat = (store: ChatStore): ChatSnapshot =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

export { createChatStore } from "./store.js";
export type { ChatSnapshot, ChatStatus, ChatStore } from "./store.js";
