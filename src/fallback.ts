/**
 * Script-widget fallback. The official Usedesk widget URL is generic per
 * account (`widget_<companyId>_<channelId>.js` — same combined id as the
 * chat protocol), so consumers can degrade to it when the native socket
 * fails (protocol drift, network policy, Centrifugo-only account).
 */

import { widgetBundleUrl } from "./discovery.js";

export interface UsedeskMessenger {
  openChat(): void;
  [key: string]: unknown;
}

declare global {
  interface Window {
    usedeskMessenger?: UsedeskMessenger;
  }
}

const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

let loading: Promise<UsedeskMessenger> | null = null;

/**
 * Inject the official widget script (idempotent) and resolve once
 * `window.usedeskMessenger` is ready. The widget renders its own launcher —
 * call `.openChat()` to jump straight into the conversation (it reads the
 * same `usedesk_messenger_token`, so the dialog carries over).
 */
export const loadOfficialWidget = (
  companyId: string,
  options?: { timeoutMs?: number },
): Promise<UsedeskMessenger> => {
  if (window.usedeskMessenger) return Promise.resolve(window.usedeskMessenger);
  if (loading) return loading;

  loading = new Promise<UsedeskMessenger>((resolve, reject) => {
    const fail = (reason: string) => {
      loading = null;
      reject(new Error(`usedesk_script_widget_${reason}`));
    };

    const script = document.createElement("script");
    script.src = widgetBundleUrl(companyId);
    script.async = true;
    script.onerror = () => fail("load_failed");
    document.head.appendChild(script);

    // The messenger global appears asynchronously after script execution.
    const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (window.usedeskMessenger) {
        clearInterval(poll);
        resolve(window.usedeskMessenger);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        fail("timeout");
      }
    }, POLL_INTERVAL_MS);
  });

  return loading;
};
