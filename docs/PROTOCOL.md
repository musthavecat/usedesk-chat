# Usedesk chat wire protocol

The Usedesk realtime chat protocol, reverse-engineered from the official widget bundle
(`widget_<companyId>_<channelId>.js`) and verified live against a production account.
This is the protocol both this package and Usedesk's own open-source mobile SDKs speak.

> ⚠️ Unofficial documentation for interoperability purposes. Shapes may drift —
> run `npx usedesk-chat doctor <companyId>` to verify against your account.

## Transport

socket.io v4 → the account's pubsub host (e.g. `https://pubsubsec4.usedesk.ru`; baked
into the account widget bundle, discoverable at runtime — see README "Config
discovery"). The server side is [redbone](https://github.com/ya-kostik/redbone)
(redux-over-socket.io): **both directions send a single socket.io event `dispatch`**
carrying a redux-style action object.

## Client → server actions (`@@server/chat/*`)

| Action | Payload | Notes |
| --- | --- | --- |
| `INIT` | `{company_id, url, payload: {userData}, token?}` | `company_id` = `"<companyId>_<channelId>"`. `userData` is REQUIRED — an empty object is rejected with `@@redbone/ERROR` 500. Fields: `userAgent, ip, pageUrl, os, browserName, browserVersion, defaultMessageOfOperator` (empty strings are accepted). Without `token` the server creates a new client + chat. |
| `SET_CLIENT` | `{payload: {token, email?, username?, phone?, additional_fields?}}` | Identify the visitor. Acked with `@@chat/current/SET`. |
| `SEND_MESSAGE` | `{message: {text}}` | The echo comes back as `ADD_MESSAGE` (`client_to_operator`). The first message creates a ticket (`payload.new_ticket_created`). |
| `GET_MESSAGES` | `{lt_id, limit}` | History page with ids strictly older than `lt_id` → `UNSHIFT_MESSAGES`. |
| `PULSE_ACTION` | `{timestamp: unixSeconds, token}` | Keepalive; the official widget sends it every 20 s. |

Other actions present in the widget protocol (not used by this client): `SET`,
`SET_EMAIL`, `CALLBACK`, `PUSH_ACTION`.

## Server → client actions (`@@chat/current/*`)

| Action | Payload |
| --- | --- |
| `INITED` | `{token, setup: {client: {pic, email, chat}, waitingEmail, messages?, callback_settings, token}}` |
| `ADD_MESSAGE` | `{message}` — see shape below. **Service messages with empty `text` exist** — filter them. |
| `PUSH_MESSAGES` / `UNSHIFT_MESSAGES` | `{messages: []}` — append / prepend (history). |
| `SET` | `{state: {client}, reset}` — `SET_CLIENT` ack, full client state (`client_id`, `name`, `email`, `messages`). |
| `CHANGE_OPERATORS_STATUS` | `{newStatus}` |
| `REQUEST_EMAIL` | The server asks for an email (channel setting). |
| `TO_RELOAD_CHAT` | `{token}` — restart the session (re-`INIT` with the new token). |
| `@@redbone/ERROR` | `{code, statusMessage, message}` |

## Message shape

```jsonc
{
  "id": 1376268928,
  "text": "…",                      // ⚠️ may be HTML (<br>) for bot/operator messages
  "createdAt": "2026-06-06T19:31:43Z",
  "chat": 110652210,
  "type": "client_to_operator",     // | operator_to_client | bot_to_client
  "name": "Support Bot",            // operator/bot display name; "" for client messages
  "ticket_id": 123456789,
  "client": { "id": 209402536, "name": "…", "avatar": null },
  "payload": { "avatar": "", "new_ticket_created": true, "channel_id": 67890 },
  "from": "client"                  // | trigger | …
}
```

Attachments arrive inside `message.file`:

```jsonc
{
  "id": "…",
  "file_name": "photo.png",
  "name": "photo.png",
  "dataType": "image",              // render previewLink as a thumbnail
  "mimeType": "image/png",
  "type": "image/png",
  "content": "https://…",           // authenticated download URL
  "size": "70 KB",                  // human-readable string, as displayed
  "previewLink": "https://…",
  "publicDownloadLink": "https://…",
  "fullLink": "https://…"
}
```

## Session lifecycle

1. Open the socket; on `connect` send `INIT` (+ the persisted token when present).
   Success = `INITED`; treat a timeout / `connect_error` as "fall back to the script
   widget".
2. `INITED` carries the session `token` — persist it (see "Token persistence"), start
   the 20 s pulse.
3. Reconnects: socket.io's manager retries (delay 2 s → 30 s); re-send `INIT` with the
   token on every reconnect.
4. **An anonymous `INIT` creates a client + chat server-side** — connect lazily, only
   when the user actually opens the chat.
5. Reset the persisted session on logout, otherwise different users' chats merge.

## Token persistence (official-widget compatible)

Key `usedesk_messenger_token`, written exactly like the official widget does:
**cookie** (24 h) + **localStorage** envelope `{data, time}`; the widget reads the
cookie first. This makes migration seamless in both directions. (The widget's own
localStorage TTL check is broken — it compares a function to a number — so its tokens
effectively live as long as the cookie/LS entry; we write `time` for compatibility but
don't enforce it on read.)

## File upload

`POST https://secure.usedesk.ru/uapi/v1/safely_send_file` — multipart form data:

| Field | Value |
| --- | --- |
| `signature` | `btoa(companyId)` (the full combined id) |
| `chat_token` | the session token |
| `file` | the binary |

The widget-side limit is 15 MiB. The response carries `{file_link}`; announce it on the
socket via `SEND_MESSAGE` with `{text: "", file: {name, type, content: file_link, size},
fileUploadType: true}` — the server echoes the attachment back as a regular
`ADD_MESSAGE` (with preview/download links), so no optimistic local message is needed.

## Account config discovery

Per-account settings are baked into the tail of the public widget bundle
(`https://s3.usedesk.ru/lib/secure.usedesk.ru/widget_<companyId>.js` — minified webpack
on top, a readable bootstrap object at the bottom). The S3 honours `Range` requests, so
~8 KB from the end is enough to read the live `pubsubUrl`, `centrifugoEnabled`,
`apiDomain` and upload endpoints.

**CORS:** the S3 sends no `Access-Control-Allow-Origin` and `Range` forces a preflight —
direct browser fetches are blocked. Proxy through your own origin in the browser;
Node/CLI/cron fetch directly.

## Centrifugo

The widget bundle carries a second transport for some accounts: `centrifugoEnabled`,
`wss://centrifugo.usedesk.ru/connection/websocket`, with a JWT obtained from
`uapi/v1/getWidgetJwt`. Centrifugo publishes the **same action objects** into a
per-client channel, so supporting it is a transport-level change, not a protocol
rewrite. This package currently ships the socket.io transport only and logs
`centrifugo_enabled_unsupported` when discovery reports a Centrifugo account.
