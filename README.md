# @musthavecat/usedesk-chat

Unofficial **headless chat client for [Usedesk](https://usedesk.com)** — build your own
chat UI on top of the Usedesk realtime socket instead of embedding their ~800 KB script
widget. Operators keep working in Usedesk; your visitors get a chat window that matches
your product.

- 🪶 **Tiny & headless** — a protocol client + an immutable-snapshot store; bring your own UI
- ⚛️ **Vue 3 / React 18 bindings** — optional subpath exports, both peer deps optional
- 🔁 **Drop-in compatible** with the official widget — shares the same session token, so
  conversations survive migration in *both* directions
- 🛟 **Built-in risk mitigation** — runtime config discovery, transport abstraction,
  script-widget fallback loader, and a `doctor` CLI protocol canary

> ⚠️ **Unofficial.** The protocol was reverse-engineered from the public widget bundle
> for interoperability (Usedesk's own open-source mobile SDKs speak the same protocol).
> Usedesk may change it at any time — that's why `connect()` rejects on timeout and a
> [fallback loader](#fallback-to-the-official-widget) for the official widget is included.
> Not affiliated with or endorsed by Usedesk.

## Install

```sh
npm install @musthavecat/usedesk-chat
```

`vue` / `react` are optional peer dependencies — install whichever you use (or neither
for vanilla JS).

## Quick start (vanilla)

```ts
import { createChatStore } from "@musthavecat/usedesk-chat";

const store = createChatStore({
  companyId: "12345_67890", // "<companyId>_<channelId>" — see below
  pubsubUrl: "https://pubsubsec4.usedesk.ru",
});

store.subscribe(() => {
  const { status, messages, connected } = store.getSnapshot();
  render(status, messages, connected);
});

await store.connect(); // resolves false on failure → fall back to the script widget
store.setClient({ name: "Jane", email: "jane@example.com" }); // pre-chat form
store.send("Hi! I have a question about my order.");
```

**Where do the IDs come from?** Look at the widget snippet in your Usedesk admin panel:
`https://lib.usedesk.ru/secure.usedesk.ru/widget_<companyId>_<channelId>.js` — the
combined `<companyId>_<channelId>` is your `companyId` here. The `pubsubUrl` is baked
into that bundle (or just enable [discovery](#config-discovery) and let the client find
it).

## Vue 3

```vue
<script setup lang="ts">
import { createChatStore } from "@musthavecat/usedesk-chat";
import { useUsedeskChat } from "@musthavecat/usedesk-chat/vue";

// Keep the store outside the component in real apps (module scope / provide)
const store = createChatStore({ companyId: "12345_67890", discover: true, discoverUrl: "/api/usedesk-config" });
const { state, connect, send } = useUsedeskChat(store);

const draft = ref("");
const submit = () => { send(draft.value); draft.value = ""; };
</script>

<template>
  <button v-if="state.status === 'idle'" @click="connect">Chat with us</button>
  <div v-else class="chat">
    <ul>
      <li v-for="m in state.messages" :key="m.id" :data-mine="m.type === 'client_to_operator'">
        <b v-if="m.name">{{ m.name }}:</b>
        <!-- m.text may contain HTML (<br>) from bots/operators — sanitize before v-html -->
        {{ m.text }}
      </li>
    </ul>
    <form @submit.prevent="submit">
      <input v-model="draft" :disabled="state.status !== 'ready'" />
      <button>Send</button>
    </form>
  </div>
</template>
```

`state` is a `shallowRef` snapshot replaced wholesale on every change; the binding
auto-unsubscribes with the component scope.

## React 18+

```tsx
import { useState } from "react";
import { createChatStore } from "@musthavecat/usedesk-chat";
import { useUsedeskChat } from "@musthavecat/usedesk-chat/react";

// Module scope (or context/ref) — the store must survive re-renders
const store = createChatStore({ companyId: "12345_67890", pubsubUrl: "https://pubsubsec4.usedesk.ru" });

export function SupportChat() {
  const { status, messages } = useUsedeskChat(store); // useSyncExternalStore inside
  const [draft, setDraft] = useState("");

  if (status === "idle") return <button onClick={() => store.connect()}>Chat with us</button>;

  return (
    <div>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.name ? `${m.name}: ` : ""}{m.text}</li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); store.send(draft); setDraft(""); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={status !== "ready"} />
        <button>Send</button>
      </form>
    </div>
  );
}
```

> **Why no ready-made `<ChatWidget>` components?** The value of this package is the
> protocol layer. A shipped UI means shipping styles, theming, i18n and a11y opinions —
> the snippets above are the whole integration; copy and restyle them.

## The store

`createChatStore(options)` wraps the low-level client into the external-store contract
every framework understands (`getSnapshot()` / `subscribe()`, immutable snapshots):

```ts
interface ChatSnapshot {
  status: "idle" | "connecting" | "ready" | "error";
  messages: ChatMessage[];   // renderable history, oldest first
  hasIdentity: boolean;      // a persisted session token exists
  operatorsStatus: unknown;  // raw CHANGE_OPERATORS_STATUS payload
  connected: boolean;        // socket connectivity
  error: { code: string; message: string } | null;
}

store.connect();             // Promise<boolean> — false → use the fallback
store.send(text);
store.sendFile(file);        // REST upload + socket announce
store.setClient({ name, email, phone, additionalFields });
store.loadOlder(limit?);     // prepend an older history page
store.checkIdentity();       // re-read the persisted token
store.resetSession();        // ⚠️ call on logout — prevents merging two users' chats
store.dispose();
store.client;                // escape hatch to the underlying UsedeskChatClient
```

## Low-level client

```ts
import { createUsedeskChat } from "@musthavecat/usedesk-chat";

const chat = createUsedeskChat({
  companyId: "12345_67890",
  pubsubUrl: "https://pubsubsec4.usedesk.ru",
  // discover: true, discoverUrl: "/api/usedesk-config",
  // logger: { log, warn, error },        // debug/telemetry sink
  // initTimeoutMs: 12_000,
  // transport: customTransportFactory,   // e.g. a future Centrifugo wire
});

chat.on("inited", (state) => {});       // INIT acked; history in state.messages
chat.on("message", (m) => {});          // realtime (incl. echo of your own)
chat.on("olderMessages", (ms) => {});   // loadOlder() response
chat.on("operatorsStatus", (s) => {});
chat.on("connection", ({ connected }) => {});
chat.on("error", ({ code, message }) => {});

const state = await chat.connect();     // rejects on timeout → fallback
chat.setClient({ name, email });
chat.sendMessage("text");
await chat.sendFile(file);              // 15 MiB widget-side limit
chat.loadOlder(firstMessageId);
chat.resetSession();                    // on logout
chat.dispose();
```

### Lifecycle notes

1. `connect()` lazily opens the socket and sends `INIT` (with the persisted token when
   present, resuming the conversation). Resolves on `INITED`, rejects on
   timeout/transport error.
2. **An anonymous `INIT` creates a client + chat on the Usedesk side** — connect only
   when the user actually opens the chat, not on page load.
3. Reconnects are handled by socket.io's manager; the client re-`INIT`s on every
   reconnect.
4. Call `resetSession()` on logout, or two users on one browser get merged into one
   conversation.

## Token & official-widget compatibility

The session token is persisted under the same key (`usedesk_messenger_token`) in **both**
a cookie (24 h) and a localStorage envelope `{data, time}` — exactly like the official
widget. Migration is therefore seamless in both directions: visitors who already chatted
through the script widget keep their conversation, and the fallback widget picks up
tokens saved by this client.

## Config discovery

Usedesk bakes per-account settings (pubsub host, REST endpoints, Centrifugo flag) into
the tail of the public widget bundle. With `discover: true` the client range-fetches
the last ~8 KB of that bundle before connecting (day-cached in localStorage), so a
Usedesk-side host migration is picked up without a redeploy.

**Browser caveat (CORS):** Usedesk's S3 sends no `Access-Control-Allow-Origin`, and the
`Range` header forces a preflight — a direct browser fetch is blocked. Point
`discoverUrl` at a tiny same-origin proxy that forwards the bundle tail (any server
runtime can do it):

```ts
// e.g. a Nuxt/Next/Express route: GET /api/usedesk-config?companyId=...
const upstream = `https://s3.usedesk.ru/lib/secure.usedesk.ru/widget_${companyId}.js`;
const res = await fetch(upstream, { headers: { Range: "bytes=-8192" } });
return new Response(await res.text());
```

In Node / CLI / cron there is no CORS — discovery works directly.

## Fallback to the official widget

```ts
import { loadOfficialWidget } from "@musthavecat/usedesk-chat";

const ok = await store.connect();
if (!ok) {
  const messenger = await loadOfficialWidget("12345_67890");
  messenger.openChat(); // same token → the dialog carries over
}
```

Recommended hooks (kept out of the SDK by design):

| Hook | Recipe |
| --- | --- |
| Telemetry | Forward `error` events / `connect() → false` + the `logger` sink into your analytics — a "native chat died" sensor |
| Kill switch | A remote flag checked before `connect()`; flip it to route everyone to the script widget in seconds, no rebuild |
| Protocol canary | Run the [doctor CLI](#doctor-cli) on a schedule in CI/cron and alert on failure |

## Doctor CLI

```sh
npx usedesk-chat doctor 12345_67890 [--token <t>] [--send <msg>] [--timeout <ms>]
```

Checks: discovery → transport connect → `INIT` → `INITED` shape → optional send/echo
round-trip. Exit code 0 = protocol healthy. **Note:** a run without `--token` creates a
throwaway client in your Usedesk account — pass a stored token for repeated runs.

## Transport abstraction

The wire lives behind a `ChatTransport` interface (default: socket.io v4, single
`dispatch` event both ways). Usedesk's bundle also carries a Centrifugo transport for
some accounts (`centrifugoEnabled`) — that's a second `TransportFactory` away, not a
client rewrite. Discovery already reports `centrifugoEnabled`, and the client logs
`centrifugo_enabled_unsupported` loudly so your fallback path kicks in.

## Protocol documentation

The full reverse-engineered protocol reference — actions, payload shapes, message
forms, file upload flow — lives in [`docs/PROTOCOL.md`](./docs/PROTOCOL.md). As far as
we know it's the only public write-up of the Usedesk chat wire protocol.

## Rendering caveats

- `message.text` **may contain HTML** (`<br>`, links) for bot/operator messages —
  sanitize before rendering as rich text, never inject raw.
- Service messages with empty text exist on the wire; the client filters them with
  `isRenderableMessage` before they reach your UI.
- Attachments arrive as `message.file` with `previewLink` (images) and download links.

## License

[MIT](./LICENSE)
