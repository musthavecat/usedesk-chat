#!/usr/bin/env node
/**
 * Protocol diagnostics CLI.
 *
 *   usedesk-chat doctor <companyId> [--token <t>] [--send <msg>] [--timeout <ms>]
 *
 * Steps: discovery (Range-fetch of the account bundle) → transport connect →
 * INIT → INITED shape validation → optional SEND_MESSAGE/echo round-trip.
 * Exit code 0 = all checks passed. Doubles as a protocol canary in CI.
 *
 * NOTE: an anonymous INIT (no --token) creates a new client+chat on the
 * Usedesk side every run — pass a stored token for repeated/scheduled runs.
 */

import { UsedeskChatClient } from "./client.js";
import { discoverConfig } from "./discovery.js";
import { storeToken } from "./token-store.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const usage = () => {
  // eslint-disable-next-line no-console
  console.log(
    "Usage: usedesk-chat doctor <companyId> [--token <t>] [--send <msg>] [--timeout <ms>]",
  );
  process.exit(64);
};

const main = async () => {
  const [, , command, companyId] = process.argv;
  if (command !== "doctor" || !companyId) usage();

  const token = arg("--token");
  const sendText = arg("--send");
  const timeoutMs = Number(arg("--timeout") ?? 15_000);

  // Node/bun shims so the browser-oriented client runs in the CLI.
  const memory = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage ??= {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  };
  (globalThis as Record<string, unknown>).document ??= { cookie: "" };
  (globalThis as Record<string, unknown>).window ??= {
    location: { href: "https://doctor.usedesk-chat.local/" },
  };
  (globalThis as Record<string, unknown>).navigator ??= {
    userAgent: "Mozilla/5.0 (compatible; usedesk-chat-doctor)",
  };

  // 1. discovery
  let pubsubUrl: string | undefined;
  try {
    const config = await discoverConfig(companyId!);
    pubsubUrl = config.pubsubUrl;
    check(
      "discovery",
      Boolean(config.pubsubUrl),
      `pubsubUrl=${config.pubsubUrl ?? "?"} centrifugo=${config.centrifugoEnabled ? "ON" : "off"}`,
    );
    if (config.centrifugoEnabled) {
      check(
        "transport support",
        false,
        "account is Centrifugo-enabled; socket.io transport may be retired",
      );
    }
  } catch (err) {
    check("discovery", false, String((err as Error).message));
  }

  if (!pubsubUrl) {
    summary();
    return;
  }

  // 2-3. connect + INIT/INITED
  if (token) storeToken(token);
  else
    // eslint-disable-next-line no-console
    console.log(
      "⚠️  no --token: this run creates a throwaway client in your Usedesk",
    );

  const client = new UsedeskChatClient({
    companyId: companyId!,
    pubsubUrl,
    initTimeoutMs: timeoutMs,
  });

  try {
    const state = await client.connect();
    check("connect + INITED", true, `chat=${state.chatId}`);
    check(
      "INITED shape",
      typeof state.token === "string" &&
        state.token.length > 0 &&
        typeof state.chatId === "number" &&
        Array.isArray(state.messages),
      `token=${state.token.slice(0, 8)}… history=${state.messages.length}`,
    );

    // 4. optional echo round-trip
    if (sendText) {
      const echo = new Promise<boolean>((resolve) => {
        const stop = client.on("message", (m) => {
          if (m.type === "client_to_operator" && m.text === sendText) {
            stop();
            resolve(true);
          }
        });
        setTimeout(() => resolve(false), timeoutMs);
      });
      client.sendMessage(sendText);
      check("send/echo round-trip", await echo);
    }
  } catch (err) {
    check("connect + INITED", false, String((err as Error).message));
  } finally {
    client.dispose();
  }

  summary();
};

const summary = () => {
  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(
    `\n${failed.length === 0 ? "✅ all checks passed" : `❌ ${failed.length}/${results.length} checks failed`}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

void main();
