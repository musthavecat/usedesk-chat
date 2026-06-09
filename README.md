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
  noOperators: boolean;      // no operators online → show the offline form
  callbackSettings: Record<string, unknown> | null;  // offline-form config (INITED)
  feedback: Record<number, "like" | "dislike">;      // CSAT choice per message id
  error: { code: string; message: string } | null;
}

store.connect();             // Promise<boolean> — false → use the fallback
store.send(text);
store.sendFile(file);        // REST upload + socket announce
store.setClient({ name, email, phone, note, additionalId, additionalFields });
store.sendFeedback(messageId, liked);  // CSAT 👍/👎 on an operator/bot message
store.clickButton(button);   // inline button: opens link buttons, sends reply buttons
store.sendOfflineForm({ name, email, message, topic?, fields? });
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
chat.on("feedback", ({ messageId, liked }) => {});      // your CSAT choice (optimistic)
chat.on("feedbackAnswer", ({ status }) => {});          // CALLBACK_ANSWER ack
chat.on("error", ({ code, message }) => {});

const state = await chat.connect();     // rejects on timeout → fallback
chat.setClient({ name, email, additionalId, note });
chat.sendMessage("text");
await chat.sendFile(file);              // 15 MiB widget-side limit
chat.loadOlder(firstMessageId);
chat.sendFeedback(messageId, true);     // 👍 / 👎 (CALLBACK action)
const url = chat.clickButton(button);   // bot quick-reply / link button
await chat.sendOfflineForm({ message, name, email }); // when state.noOperators
chat.resetSession();                    // on logout
chat.dispose();
```

Bot **buttons** and **lead-forms** are embedded in the message text as markup —
`{{button:name;url;type;visibility}}` and `{{form;name;type;required}}` — and decoded
automatically into `ChatMessage.buttons` (`{ title, url, target, visible }`) and
`ChatMessage.forms`, stripped from `text`. Render buttons, then `chat.clickButton(button)`
(opens link buttons / sends reply buttons). `parseButtonsMessage` / `parseFormMessage`
are exported standalone.

For **forms**, the full official flow is: `chat.fetchFormFields(ids)` (POST
`/v1/widget/field_list`) loads each custom field's input type + options so you can render
text inputs / checkboxes / dropdowns, then `chat.submitFormMessage([{ field, value }, …])`
(POST `/v1/widget/custom_form/save`) submits the structured answers. For a simple
built-in-only form, `chat.submitForm([{ field, value }, …])` is a one-call shortcut that
maps the answers to a `SET_CLIENT` identify instead.

When a message requests a CSAT rating, `message.feedbackRequested` is true (and
`message.feedbackRating` holds an already-given `"like"`/`"dislike"`) — that's when to
render 👍/👎 and call `chat.sendFeedback(message.id, liked)`.

`state.noOperators` / `state.callbackSettings` (from `INITED`) drive the offline-form
path; the offline form posts over REST (`widget.js/post`), so it works even without an
open socket. `chat.sendAdditionalFields(fields, nested?)` attaches custom ticket fields,
`chat.sendAvatar(blob, identity?)` uploads the visitor avatar, and the `firstMessage`
option auto-sends an opener on a brand-new chat.

### Optimistic send (opt-in)

With `optimistic: true`, `sendMessage` renders the message immediately with
`message.sendStatus === "sending"` and a `message.localId`. The server echo (matched by
`payload.message_id`) reconciles it in place to `"sent"`; if the socket is down it flips
to `"failed"` and you can `chat.retry(message.localId)`. It's **off by default** because
reconciliation relies on the server echoing `message_id` back — verify that for your
account before enabling, or duplicate messages will appear.

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

## Knowledge Base

A separate, headless REST client for the Usedesk Knowledge Base — independent of the
chat socket. It authenticates with the KB `api_token` + numeric `knowledgeBaseId`
(not the chat company id):

```ts
import { createKnowledgeBase } from "@musthavecat/usedesk-chat";

const kb = createKnowledgeBase({ knowledgeBaseId: 123, apiToken: "…" });

const sections = await kb.getSections();              // sections → categories → stubs
const { articles } = await kb.searchArticles({ query: "refund" });
const article = await kb.getArticle(456);             // full body (HTML)
await kb.addArticleView(456);                         // view telemetry
await kb.rateArticle(456, true);                      // 👍 / 👎
await kb.sendArticleReview({                           // "didn't help" → opens a ticket
  articleId: 456, subject: "…", message: "…", tag: "kb", email: "a@b.c",
});
```

Endpoints and params are verified against the official mobile SDK; response types
mirror its models. Bring your own UI — this is data only.

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

## Development

```sh
bun test          # forms, token-store, discovery, KB, client (fake transport), store
bun run build     # tsc → dist (ESM + .d.ts)
```

The client is built around an injectable `ChatTransport`, so the whole protocol is
unit-tested offline with a fake transport — no socket, no network.

## License

[MIT](./LICENSE)
