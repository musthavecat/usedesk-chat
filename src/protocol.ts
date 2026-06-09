/**
 * Usedesk chat socket.io protocol — reverse-engineered from the official
 * widget bundle (widget_<companyId>_<channelId>.js) and verified live against
 * `pubsubsec4.usedesk.ru` (see docs/PROTOCOL.md). Both directions ride a
 * single socket.io event `dispatch` carrying redux-style actions.
 */

// ── client → server actions (`@@server/chat/*`) ─────────────────────────

export const SERVER_PREFIX = "@@server/chat/";

/**
 * Browser/page info the server requires in INIT.payload.userData — an INIT
 * with an empty userData object is rejected with `@@redbone/ERROR` 500.
 * The official widget resolves `ip` via https://api.usedesk.ru/ip.
 */
export interface ChatUserData {
  userAgent: string;
  ip: string;
  pageUrl: string;
  os: string;
  browserName: string;
  browserVersion: string;
  /** Widget pre-set operator greeting; empty string when unused. */
  defaultMessageOfOperator: string;
}

export interface InitAction {
  type: `${typeof SERVER_PREFIX}INIT`;
  /** Combined `<companyId>_<channelId>`, e.g. `12345_67890`. */
  company_id: string;
  /** Page URL the chat was opened from. */
  url: string;
  payload: { userData: ChatUserData };
  /** Omit for a fresh anonymous chat; pass to resume an existing one. */
  token?: string;
}

export interface SetClientAction {
  type: `${typeof SERVER_PREFIX}SET_CLIENT`;
  payload: {
    token: string;
    email?: string;
    username?: string;
    phone?: string;
    /** Free-text note attached to the ticket/client. */
    note?: string;
    /** Stable external customer id (cross-device identify key). */
    additional_id?: string;
    additional_fields?: Array<{ id: number; value: string | number | boolean }>;
  };
}

/**
 * Feedback / inline-action callback (`@@server/chat/CALLBACK`). Used for CSAT
 * thumbs on operator/bot messages: `data` = `"LIKE" | "DISLIKE"`, `messageId`
 * = the rated message id (as a string). `type: "action"` is the only observed
 * variant. Present in the web widget bundle; the server acks with
 * `@@chat/current/CALLBACK_ANSWER`.
 */
export interface CallbackAction {
  type: `${typeof SERVER_PREFIX}CALLBACK`;
  payload: {
    data: "LIKE" | "DISLIKE" | (string & {});
    type: "action" | (string & {});
    messageId?: string;
  };
}

/**
 * File descriptor inside SEND_MESSAGE: the binary goes through REST
 * (`/safely_send_file` → `{file_link}`), then the link is announced on the
 * socket with this shape (mirrors the official widget's onChange payload).
 */
export interface ChatFilePayload {
  name: string;
  type: string;
  /** The `file_link` URL returned by the upload endpoint. */
  content: string;
  /** Human-readable size, e.g. `"12 KB"`. */
  size: string;
}

export interface SendMessageAction {
  type: `${typeof SERVER_PREFIX}SEND_MESSAGE`;
  message: {
    text: string;
    file?: ChatFilePayload;
    fileUploadType?: boolean;
    /** Local id the server echoes back, for optimistic reconciliation. */
    payload?: { message_id?: string };
  };
}

export interface GetMessagesAction {
  type: `${typeof SERVER_PREFIX}GET_MESSAGES`;
  /** Return messages with id strictly less than this one. */
  lt_id: number;
  limit: number;
}

/** App-level keepalive; the official widget sends it every 20s. */
export interface PulseAction {
  type: `${typeof SERVER_PREFIX}PULSE_ACTION`;
  /** Unix seconds. */
  timestamp: number;
  token: string;
}

export type ChatServerAction =
  | InitAction
  | SetClientAction
  | SendMessageAction
  | GetMessagesAction
  | CallbackAction
  | PulseAction;

// ── server → client actions (`@@chat/current/*`, `@@redbone/*`) ─────────

export type ChatMessageType =
  | "client_to_operator"
  | "operator_to_client"
  | "bot_to_client";

/** Attachment as it comes back from the server inside a message. */
export interface ChatReceivedFile {
  id: string;
  file_name: string;
  name: string;
  /** `"image"` for pictures — render `previewLink` as a thumbnail. */
  dataType: string;
  mimeType: string;
  type: string;
  /** Authenticated download URL. */
  content: string;
  /** Human-readable, e.g. `"70 bytes"`. */
  size: string;
  previewLink?: string;
  publicDownloadLink?: string;
  fullLink?: string;
}

/**
 * Inline button carried on bot/trigger messages. A button with a `url` is a
 * link (open it on click); otherwise clicking sends `title` back as a regular
 * message. `visible: false` buttons are hidden (e.g. already-taken branches).
 */
export interface ChatMessageButton {
  title: string;
  url: string;
  /** Link target for url buttons: `blank` (new tab) or `self` (default). */
  target?: "blank" | "self";
  visible: boolean;
}

/**
 * Client attribute a bot form field maps to (the `associate` in the markup).
 * `additionalField` carries a numeric `fieldId` (a ticket custom field).
 */
export type FormFieldType =
  | "email"
  | "phone"
  | "name"
  | "note"
  | "position"
  | "additionalField";

/**
 * A bot lead-form field, decoded from the `{{form;name;type;required}}` markup
 * embedded in a bot message's text (see `parseFormMessage` in `forms.ts`).
 */
export interface ChatMessageFormField {
  /** Field key/label from the markup. */
  name: string;
  type: FormFieldType;
  /** Set only when `type === "additionalField"`. */
  fieldId?: number;
  required: boolean;
}

export interface ChatMessage {
  id: number;
  /** May contain HTML (`<br>`) — render as constrained rich text, never raw. */
  text: string;
  /** ISO8601. */
  createdAt: string;
  chat: number | null;
  type: ChatMessageType;
  /** Operator/bot display name; empty string for client messages. */
  name: string;
  ticket_id?: number;
  client?: { id: number; name: string | null; avatar: string | null };
  agent?: { name: string };
  payload?: {
    avatar?: string;
    new_ticket_created?: boolean;
    channel_id?: number;
    [key: string]: unknown;
  } | null;
  file?: ChatReceivedFile | null;
  /** Inline quick-reply / link buttons, decoded from `{{button;…}}` markup. */
  buttons?: ChatMessageButton[];
  /** Lead-form fields decoded from `{{form;…}}` markup in a bot message. */
  forms?: ChatMessageFormField[];
  /**
   * This message asks the visitor to rate the conversation (render 👍/👎).
   * Derived from `payload.csi` / `payload.userRating`.
   */
  feedbackRequested?: boolean;
  /** The rating already submitted for this message, when present. */
  feedbackRating?: "like" | "dislike";
  /**
   * Local id of an optimistic outgoing message (set with `optimistic: true`);
   * matches the server echo's `payload.message_id`. Absent on received messages.
   */
  localId?: string;
  /** Optimistic send lifecycle; undefined for received messages. */
  sendStatus?: "sending" | "sent" | "failed";
  from?: "client" | "trigger" | string;
}

export interface ChatClientState {
  pic: string | null;
  email: string | null;
  name?: string | null;
  client_id?: number;
  /** Chat (conversation) id. */
  chat: number;
  messages?: ChatMessage[];
}

export interface InitedEvent {
  type: "@@chat/current/INITED";
  token: string;
  setup: {
    client: ChatClientState;
    waitingEmail: boolean;
    /** Present (possibly empty) on a fresh chat; may be omitted on resume. */
    messages?: ChatMessage[];
    noOperators?: boolean;
    callback_settings?: Record<string, unknown>;
    token: string;
  };
}

export interface AddMessageEvent {
  type: "@@chat/current/ADD_MESSAGE";
  message: ChatMessage;
}

/** History pages for GET_MESSAGES are prepended via UNSHIFT_MESSAGES. */
export interface UnshiftMessagesEvent {
  type: "@@chat/current/UNSHIFT_MESSAGES";
  messages: ChatMessage[];
}

export interface PushMessagesEvent {
  type: "@@chat/current/PUSH_MESSAGES";
  messages: ChatMessage[];
}

/** SET_CLIENT ack — full client state snapshot. */
export interface SetEvent {
  type: "@@chat/current/SET";
  state: { client: ChatClientState & { token: string } };
  reset: boolean;
}

export interface ChangeOperatorsStatusEvent {
  type: "@@chat/current/CHANGE_OPERATORS_STATUS";
  newStatus: unknown;
}

export interface RequestEmailEvent {
  type: "@@chat/current/REQUEST_EMAIL";
}

/** Server asks the client to restart the session (token may rotate). */
export interface ToReloadChatEvent {
  type: "@@chat/current/TO_RELOAD_CHAT";
  token: string;
  payload?: unknown;
}

export interface RedboneErrorEvent {
  type: "@@redbone/ERROR";
  code: number;
  statusMessage: string;
  message: string;
}

/** Ack for a CALLBACK (feedback) action — `answer.status` = accepted. */
export interface CallbackAnswerEvent {
  type: "@@chat/current/CALLBACK_ANSWER";
  answer?: { status?: boolean };
}

export type ChatClientEvent =
  | InitedEvent
  | AddMessageEvent
  | UnshiftMessagesEvent
  | PushMessagesEvent
  | SetEvent
  | ChangeOperatorsStatusEvent
  | RequestEmailEvent
  | ToReloadChatEvent
  | CallbackAnswerEvent
  | RedboneErrorEvent;
