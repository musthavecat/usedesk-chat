/**
 * Bot lead-form markup parser. Usedesk bot scenarios embed lead-capture form
 * fields directly in a message's text as `{{form;<name>;<type>;<required>}}`
 * tokens (mirrors `UDFormMessageManager` in the official mobile SDK). Each
 * token is one field; the visible text is the message minus the tokens.
 *
 * `<type>` is one of email/phone/name/note/position, OR a numeric ticket
 * custom-field id (→ `additionalField`). A third `true` segment marks the
 * field required. The literal `additionalField` (without an id) is rejected.
 *
 * The parse is gated on the `{{form;` marker, so it's a no-op for the vast
 * majority of messages that carry no form.
 */

import type { ChatMessageFormField, FormFieldType } from "./protocol.js";

const FORM_KEY = "{{form;";
const FORM_END = "}}";
const KNOWN_TYPES = new Set<FormFieldType>([
  "email",
  "phone",
  "name",
  "note",
  "position",
]);

export interface ParsedFormMessage {
  /** Message text with all form markup removed (trimmed). */
  text: string;
  /** Fields decoded from the markup (empty when none). */
  forms: ChatMessageFormField[];
}

const fieldFromParams = (params: string[]): ChatMessageFormField | null => {
  const name = params[0];
  const raw = params[1];
  if (!name || raw === undefined) return null;
  // A bare `additionalField` (no concrete id) is meaningless — reject.
  if (raw === "additionalField") return null;

  let type: FormFieldType;
  let fieldId: number | undefined;
  if (KNOWN_TYPES.has(raw as FormFieldType)) {
    type = raw as FormFieldType;
  } else if (/^\d+$/.test(raw)) {
    type = "additionalField";
    fieldId = Number(raw);
  } else {
    return null;
  }

  const required = params[2] === "true";
  return fieldId === undefined
    ? { name, type, required }
    : { name, type, fieldId, required };
};

/**
 * Split a message into its visible text and the lead-form fields encoded in
 * `{{form;…}}` markup. Returns the message untouched (and `forms: []`) when no
 * marker is present.
 */
export const parseFormMessage = (message: string): ParsedFormMessage => {
  if (!message || !message.includes(FORM_KEY)) {
    return { text: message ?? "", forms: [] };
  }

  const forms: ChatMessageFormField[] = [];
  let text = message;
  let cursor = 0;

  for (;;) {
    const start = message.indexOf(FORM_KEY, cursor);
    if (start === -1) break;
    const end = message.indexOf(FORM_END, start + FORM_KEY.length);
    if (end === -1) break;

    const block = message.slice(start, end + FORM_END.length);
    const inner = block.slice(FORM_KEY.length, block.length - FORM_END.length);
    const field = fieldFromParams(inner.split(";"));
    if (field) {
      forms.push(field);
      text = text.replace(block, "");
    }
    cursor = end + FORM_END.length;
  }

  return { text: text.trim(), forms };
};

/** True when the text carries at least one form token. */
export const hasFormMarkup = (text: string): boolean =>
  Boolean(text) && text.includes(FORM_KEY);
