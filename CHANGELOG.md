# Changelog

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
