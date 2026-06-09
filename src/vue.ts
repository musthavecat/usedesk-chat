/**
 * Vue 3 binding (`@musthavecat/usedesk-chat/vue`). Vue is an optional peer dep —
 * importing this subpath outside a Vue app is the only thing that requires it.
 *
 * ```ts
 * const store = createChatStore({ companyId, pubsubUrl });
 * const { state, connect, send } = useUsedeskChat(store);
 * // state.value.messages / state.value.status — reactive snapshot
 * ```
 */

import {
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  type ShallowRef,
} from "vue";
import type { ChatSnapshot, ChatStore } from "./store.js";

export interface UseUsedeskChatReturn
  extends Pick<
    ChatStore,
    | "connect"
    | "send"
    | "sendFile"
    | "setClient"
    | "sendFeedback"
    | "clickButton"
    | "sendOfflineForm"
    | "submitForm"
    | "fetchFormFields"
    | "submitFormMessage"
    | "sendAdditionalFields"
    | "sendAvatar"
    | "retry"
    | "loadOlder"
    | "checkIdentity"
    | "resetSession"
    | "dispose"
  > {
  /** Reactive snapshot — replaced wholesale on every store change. */
  state: ShallowRef<ChatSnapshot>;
  /** Detach from the store without disposing the chat itself. */
  stop: () => void;
}

export const useUsedeskChat = (store: ChatStore): UseUsedeskChatReturn => {
  const state = shallowRef(store.getSnapshot());
  const stop = store.subscribe(() => {
    state.value = store.getSnapshot();
  });
  // Auto-cleanup when called inside a component/effect scope; for usage
  // outside one (e.g. a module singleton) the caller keeps `stop`.
  if (getCurrentScope()) onScopeDispose(stop);

  return {
    state,
    stop,
    connect: store.connect,
    send: store.send,
    sendFile: store.sendFile,
    setClient: store.setClient,
    sendFeedback: store.sendFeedback,
    clickButton: store.clickButton,
    sendOfflineForm: store.sendOfflineForm,
    submitForm: store.submitForm,
    fetchFormFields: store.fetchFormFields,
    submitFormMessage: store.submitFormMessage,
    sendAdditionalFields: store.sendAdditionalFields,
    sendAvatar: store.sendAvatar,
    retry: store.retry,
    loadOlder: store.loadOlder,
    checkIdentity: store.checkIdentity,
    resetSession: store.resetSession,
    dispose: store.dispose,
  };
};

export { createChatStore } from "./store.js";
export type { ChatSnapshot, ChatStatus, ChatStore } from "./store.js";
