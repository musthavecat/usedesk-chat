/**
 * Inline-button markup parser. Like forms, bot/trigger quick-reply buttons are
 * embedded in a message's text as `{{button:<name>;<url>;<linkType>;<visibility>}}`
 * tokens (per the official docs, en.usedocs.com/article/12382, and the mobile
 * SDK's `buttonFromString`) — they are NOT a separate JSON field on the wire.
 * Segments: name (required), url, linkType (`blank`|`self`), visibility
 * (`noshow` hides the button). Note the marker uses a COLON (`{{button:`),
 * unlike forms' `{{form;`.
 *
 * Gated on the `{{button:` marker, so it's a no-op for plain messages.
 */

import type { ChatMessageButton } from "./protocol.js";

const BUTTON_KEY = "{{button:";
const BUTTON_END = "}}";

export interface ParsedButtonsMessage {
  /** Message text with all button markup removed (trimmed). */
  text: string;
  /** Buttons decoded from the markup (empty when none). */
  buttons: ChatMessageButton[];
}

const buttonFromInner = (inner: string): ChatMessageButton | null => {
  const parts = inner.split(";");
  const title = parts[0];
  if (!title) return null;
  return {
    title,
    url: parts[1] ?? "",
    target: parts[2] === "blank" ? "blank" : "self",
    // 4th segment `noshow` hides the button (already-taken branch).
    visible: parts[3] !== "noshow",
  };
};

/**
 * Split a message into its visible text and the inline buttons encoded in
 * `{{button:…}}` markup. Returns the message untouched (and `buttons: []`)
 * when no marker is present.
 */
export const parseButtonsMessage = (message: string): ParsedButtonsMessage => {
  if (!message || !message.includes(BUTTON_KEY)) {
    return { text: message ?? "", buttons: [] };
  }

  const buttons: ChatMessageButton[] = [];
  let text = message;
  let cursor = 0;

  for (;;) {
    const start = message.indexOf(BUTTON_KEY, cursor);
    if (start === -1) break;
    const end = message.indexOf(BUTTON_END, start + BUTTON_KEY.length);
    if (end === -1) break;

    const block = message.slice(start, end + BUTTON_END.length);
    const inner = block.slice(BUTTON_KEY.length, block.length - BUTTON_END.length);
    const button = buttonFromInner(inner);
    if (button) {
      buttons.push(button);
      text = text.replace(block, "");
    }
    cursor = end + BUTTON_END.length;
  }

  return { text: text.trim(), buttons };
};

/** True when the text carries at least one button token. */
export const hasButtonMarkup = (text: string): boolean =>
  Boolean(text) && text.includes(BUTTON_KEY);
