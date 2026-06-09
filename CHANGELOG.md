# Changelog

## 0.2.0 — 2026-06-09

Protocol parity with the official mobile SDKs (verified against
`UseDeskSwift`):

- **CSAT feedback** — `client.sendFeedback(messageId, liked)` sends the
  `@@server/chat/CALLBACK` action (`LIKE` / `DISLIKE`); the server ack
  `@@chat/current/CALLBACK_ANSWER` is surfaced via the new `feedbackAnswer`
  event, and the store tracks the choice optimistically in
  `snapshot.feedback` (keyed by message id)
- **Inline message buttons** — `ChatMessage.buttons` (`{title, url, visible}`)
  for bot/trigger quick replies; `client.clickButton(button)` opens link
  buttons or sends reply buttons as a message
- **`additionalId` + `note`** on `setClient()` — stable cross-device identify
  key (`additional_id`) and a free-text ticket note
- **Offline form** — `client.sendOfflineForm({name, email, message, topic?,
  fields?})` posts to the widget offline endpoint when no operators are
  online; `snapshot.noOperators` / `snapshot.callbackSettings` exposed from
  INITED to drive the form
- Vue binding exposes `sendFeedback` / `clickButton` / `sendOfflineForm`
- **Knowledge Base** — `createKnowledgeBase({ knowledgeBaseId, apiToken })`
  headless REST client: `getSections()`, `getArticle(id)`, `searchArticles()`,
  `addArticleView()`, `rateArticle(id, helpful)`, `sendArticleReview()`.
  Independent of the chat socket; endpoints/params verified against the
  official SDK (response shapes mirror its models)
- **Bot lead-forms** — `{{form;name;type;required}}` markup in bot messages is
  decoded into `ChatMessage.forms` (`parseFormMessage` util) and stripped from
  the rendered text. Two submit paths: `fetchFormFields(ids)` (`/v1/widget/field_list`)
  loads custom-field definitions (text/checkbox/select + options) for rendering,
  and `submitFormMessage(fields)` (`/v1/widget/custom_form/save`) is the official,
  complete submit; `submitForm(filled)` stays as a SET_CLIENT shortcut for the
  built-in fields. Inert for messages without the marker
- **Inline buttons** — now decoded from `{{button:name;url;type;visibility}}`
  markup in the message text (verified against en.usedocs.com/article/12382 —
  buttons are NOT a JSON field on the wire), with `target` (`blank`/`self`).
  Replaces the earlier JSON-field assumption
- **Inbound CSAT flag** — `ChatMessage.feedbackRequested` / `feedbackRating`
  (from `payload.csi` / `payload.userRating`) so the UI knows which messages
  show 👍/👎 — the companion to `sendFeedback`
- **`sendAdditionalFields(fields, nested?)`** — attach custom ticket fields
  (incl. nested groups) via the `addFieldsToChat` REST flow
- **`sendAvatar(blob, identity?)`** — upload the visitor's avatar (multipart)
- **`firstMessage` option** — auto-sent once on the first INITED of a new chat
- **Optimistic send** (`optimistic: true`, opt-in) — outgoing messages render
  immediately with `message.sendStatus` `sending` → `sent` (reconciled by the
  echo's `payload.message_id`) or `failed` when the socket is down; `retry(localId)`
  re-sends. Off by default (reconciliation needs the server to echo message_id)
- **Tests** — `bun test` suite (66 cases) covering forms, buttons, token-store,
  discovery, KB, the client (fake transport), the store, and optimistic send

## 0.1.0

Initial public release.

- `UsedeskChatClient` — INIT/INITED, sendMessage, setClient, GET_MESSAGES history
  paging, 20 s pulse keepalive; session token persisted cookie + localStorage,
  bidirectionally compatible with the official script widget
- File upload (`safely_send_file` REST + socket announce)
- Headless `createChatStore` — immutable snapshots, `getSnapshot()`/`subscribe()`
- `@musthavecat/usedesk-chat/vue` (Vue 3, `shallowRef`) and `@musthavecat/usedesk-chat/react`
  (React 18+, `useSyncExternalStore`) bindings; both peer deps optional
- Runtime account-config discovery (range-fetch of the widget bundle tail, day cache,
  proxy support for browser CORS)
- `ChatTransport` abstraction (socket.io default; Centrifugo-ready interface)
- `loadOfficialWidget` script-widget fallback loader
- `usedesk-chat doctor` CLI — protocol canary for CI/cron
