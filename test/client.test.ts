import { beforeEach, describe, expect, it } from "bun:test";

import {
  isRenderableMessage,
  UsedeskChatClient,
  type ChatState,
} from "../src/client.js";
import type { ChatMessage } from "../src/protocol.js";
import {
  addMessageAction,
  initedAction,
  installStorage,
  makeFakeTransport,
  mockFetch,
  tick,
  type FakeTransport,
} from "./helpers.js";

const find = (ft: FakeTransport, type: string) =>
  ft.sent.find((a) => a.type === type);

async function connect(over: Record<string, unknown> = {}) {
  const ft = makeFakeTransport();
  const chat = new UsedeskChatClient({
    companyId: "1_2",
    pubsubUrl: "https://x",
    transport: ft.factory,
  });
  const p = chat.connect();
  await tick();
  ft.emit(initedAction(over));
  const state = await p;
  return { ft, chat, state };
}

describe("UsedeskChatClient", () => {
  beforeEach(() => {
    installStorage();
  });

  it("sends INIT on connect and resolves on INITED", async () => {
    const { ft, chat, state } = await connect();
    const init = find(ft, "@@server/chat/INIT");
    expect(init).toBeTruthy();
    expect((init as { company_id: string }).company_id).toBe("1_2");
    expect(state.token).toBe("tok-1");
    expect(chat.token).toBe("tok-1");
    expect(chat.hasIdentity).toBe(true);
    chat.dispose();
  });

  it("exposes noOperators + callbackSettings from INITED", async () => {
    const { chat, state } = await connect({
      noOperators: true,
      callback_settings: { foo: 1 },
    });
    expect(state.noOperators).toBe(true);
    expect(state.callbackSettings).toEqual({ foo: 1 });
    chat.dispose();
  });

  it("setClient maps note + additionalId to the wire fields", async () => {
    const { ft, chat } = await connect();
    chat.setClient({
      name: "Jane",
      email: "j@e.c",
      note: "vip",
      additionalId: "uuid-1",
      additionalFields: [{ id: 3, value: "x" }],
    });
    const sc = find(ft, "@@server/chat/SET_CLIENT") as {
      payload: Record<string, unknown>;
    };
    expect(sc.payload).toMatchObject({
      token: "tok-1",
      username: "Jane",
      email: "j@e.c",
      note: "vip",
      additional_id: "uuid-1",
      additional_fields: [{ id: 3, value: "x" }],
    });
    chat.dispose();
  });

  it("sendFeedback sends a CALLBACK and emits feedback", async () => {
    const { ft, chat } = await connect();
    const events: Array<{ messageId: number; liked: boolean }> = [];
    chat.on("feedback", (e) => events.push(e));
    chat.sendFeedback(5, true);
    expect(find(ft, "@@server/chat/CALLBACK")).toMatchObject({
      payload: { data: "LIKE", type: "action", messageId: "5" },
    });
    expect(events).toEqual([{ messageId: 5, liked: true }]);
    chat.dispose();
  });

  it("CALLBACK_ANSWER is surfaced as feedbackAnswer", async () => {
    const { ft, chat } = await connect();
    const acks: Array<{ status: boolean }> = [];
    chat.on("feedbackAnswer", (a) => acks.push(a));
    ft.emit({ type: "@@chat/current/CALLBACK_ANSWER", answer: { status: true } });
    expect(acks).toEqual([{ status: true }]);
    chat.dispose();
  });

  it("clickButton opens links and sends reply buttons", async () => {
    const { ft, chat } = await connect();
    expect(
      chat.clickButton({ title: "T", url: "https://u", visible: true }),
    ).toBe("https://u");
    expect(chat.clickButton({ title: "Reply", url: "", visible: true })).toBeNull();
    const sent = find(ft, "@@server/chat/SEND_MESSAGE") as {
      message: { text: string };
    };
    expect(sent.message.text).toBe("Reply");
    chat.dispose();
  });

  it("decodes form markup on an incoming message", async () => {
    const { ft, chat } = await connect();
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    ft.emit(
      addMessageAction({ id: 5, text: "Fill {{form;Email;email;true}} now" }),
    );
    expect(got[0]?.text).not.toContain("{{form");
    expect(got[0]?.forms).toEqual([
      { name: "Email", type: "email", required: true },
    ]);
    chat.dispose();
  });

  it("keeps a pure-form message renderable (text strips to empty)", async () => {
    const { ft, chat } = await connect();
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    ft.emit(addMessageAction({ id: 6, text: "{{form;Email;email}}" }));
    expect(got).toHaveLength(1);
    expect(got[0]?.forms).toHaveLength(1);
    chat.dispose();
  });

  it("decodes button markup on an incoming message", async () => {
    const { ft, chat } = await connect();
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    ft.emit(
      addMessageAction({ id: 7, text: "Pick {{button:Yes;https://y;blank}}" }),
    );
    expect(got[0]?.text).not.toContain("{{button");
    expect(got[0]?.buttons).toEqual([
      { title: "Yes", url: "https://y", target: "blank", visible: true },
    ]);
    chat.dispose();
  });

  it("derives feedback flags from the message payload", async () => {
    const { ft, chat } = await connect();
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    ft.emit(addMessageAction({ id: 8, text: "Rate us", payload: { csi: true } }));
    ft.emit(
      addMessageAction({ id: 9, text: "Thanks", payload: { userRating: "LIKE" } }),
    );
    expect(got[0]?.feedbackRequested).toBe(true);
    expect(got[1]?.feedbackRating).toBe("like");
    chat.dispose();
  });

  it("sendAdditionalFields posts addFieldsToChat with nested groups", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: true, status: 200, json: {} }));
    const { chat } = await connect();
    await chat.sendAdditionalFields(
      [{ id: 1, value: "a" }],
      [[{ id: 2, value: "b" }]],
    );
    const call = f.calls.at(-1);
    expect(call?.url).toBe(
      "https://secure.usedesk.ru/uapi/v1/addFieldsToChat",
    );
    const body = JSON.parse(String(call?.init?.body));
    expect(body.chat_token).toBe("tok-1");
    expect(body.additional_fields).toEqual([
      { id: 1, value: "a" },
      [{ id: 2, value: "b" }],
    ]);
    chat.dispose();
  });

  it("sendAvatar uploads multipart to the setClient endpoint", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: true, status: 200, json: {} }));
    const { chat } = await connect();
    await chat.sendAvatar(new Blob(["x"]), { name: "Jo" });
    const call = f.calls.at(-1);
    expect(call?.url).toBe("https://secure.usedesk.ru/v1/chat/setClient");
    expect(call?.init?.body).toBeInstanceOf(FormData);
    chat.dispose();
  });

  it("firstMessage auto-sends once on a fresh INITED", async () => {
    const ft = makeFakeTransport();
    const chat = new UsedeskChatClient({
      companyId: "1_2",
      pubsubUrl: "https://x",
      transport: ft.factory,
      firstMessage: "hello there",
    });
    const p = chat.connect();
    await tick();
    ft.emit(initedAction());
    await p;
    expect(
      ft.sent.some(
        (a) =>
          a.type === "@@server/chat/SEND_MESSAGE" &&
          (a.message as { text: string }).text === "hello there",
      ),
    ).toBe(true);
    chat.dispose();
  });

  it("submitForm maps fields to a SET_CLIENT identify", async () => {
    const { ft, chat } = await connect();
    chat.submitForm([
      { field: { name: "E", type: "email", required: true }, value: "a@b.c" },
      { field: { name: "N", type: "name", required: false }, value: "Jo" },
      {
        field: { name: "C", type: "additionalField", fieldId: 7, required: false },
        value: "v",
      },
    ]);
    const sc = find(ft, "@@server/chat/SET_CLIENT") as {
      payload: Record<string, unknown>;
    };
    expect(sc.payload).toMatchObject({
      email: "a@b.c",
      username: "Jo",
      additional_fields: [{ id: 7, value: "v" }],
    });
    chat.dispose();
  });

  it("fetchFormFields POSTs ids to field_list and parses definitions", async () => {
    const f = mockFetch();
    f.setResponder(() => ({
      ok: true,
      json: {
        fields: {
          "20995": {
            id: 20995,
            name: "City",
            ticket_field_type_id: 2,
            children: [
              { id: 1, value: "NYC" },
              { id: 2, value: "LA", parent_option_id: [9] },
            ],
          },
          "30012": { id: 30012, name: "Agree", ticket_field_type_id: 3 },
        },
      },
    }));
    const { chat } = await connect();
    const defs = await chat.fetchFormFields([20995, 30012, 0]);
    const call = f.calls.at(-1);
    expect(call?.url).toBe(
      "https://secure.usedesk.ru/v1/widget/field_list",
    );
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      chat: "tok-1",
      ids: "20995,30012",
    });
    expect(defs).toEqual([
      {
        id: 20995,
        name: "City",
        inputType: "select",
        options: [
          { id: 1, value: "NYC" },
          { id: 2, value: "LA", parentOptionIds: [9] },
        ],
      },
      { id: 30012, name: "Agree", inputType: "checkbox", options: [] },
    ]);
    chat.dispose();
  });

  it("fetchFormFields returns [] when there are no custom field ids", async () => {
    const f = mockFetch();
    const { chat } = await connect();
    expect(await chat.fetchFormFields([])).toEqual([]);
    expect(f.calls).toHaveLength(0); // no request fired
    chat.dispose();
  });

  it("submitFormMessage POSTs the structured custom_form/save payload", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: true, status: 200, json: {} }));
    const { chat } = await connect();
    await chat.submitFormMessage([
      { field: { name: "Email", type: "email", required: true }, value: "a@b.c" },
      {
        field: { name: "Agree", type: "additionalField", fieldId: 30012, required: false },
        value: true,
      },
      {
        field: { name: "City", type: "additionalField", fieldId: 20995, required: false },
        value: 2,
      },
    ]);
    const call = f.calls.at(-1);
    expect(call?.url).toBe(
      "https://secure.usedesk.ru/v1/widget/custom_form/save",
    );
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      chat: "tok-1",
      form: [
        { associate: "email", required: true, value: "a@b.c", label: "Email" },
        { associate: 30012, value: "true", label: "Agree" },
        { associate: 20995, value: "2", label: "City" },
      ],
    });
    chat.dispose();
  });

  it("sendOfflineForm POSTs JSON to the widget endpoint", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: true, status: 200, json: {} }));
    const chat = new UsedeskChatClient({
      companyId: "1_2",
      pubsubUrl: "https://x",
    });
    await chat.sendOfflineForm({ message: "hi", name: "Jo", email: "a@b.c" });
    const call = f.calls[0];
    expect(call?.url).toBe("https://secure.usedesk.ru/widget.js/post");
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      company_id: "1_2",
      message: "hi",
      name: "Jo",
      email: "a@b.c",
    });
  });

  it("sendFile uploads then announces the link on the socket", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: true, json: { file_link: "https://f/x.png" } }));
    const { ft, chat } = await connect();
    const file = new File(["data"], "x.png", { type: "image/png" });
    await chat.sendFile(file);
    expect(f.calls[0]?.url).toBe(
      "https://secure.usedesk.ru/uapi/v1/safely_send_file",
    );
    const announce = ft.sent.find(
      (a) =>
        a.type === "@@server/chat/SEND_MESSAGE" &&
        (a.message as { file?: unknown }).file,
    ) as { message: { file: { content: string } } };
    expect(announce.message.file.content).toBe("https://f/x.png");
    chat.dispose();
  });

  it("resetSession drops the persisted identity", async () => {
    const { chat } = await connect();
    expect(chat.hasIdentity).toBe(true);
    chat.resetSession();
    expect(chat.hasIdentity).toBe(false);
    chat.dispose();
  });

  it("rejects connect on a transport error", async () => {
    const ft = makeFakeTransport();
    const chat = new UsedeskChatClient({
      companyId: "1_2",
      pubsubUrl: "https://x",
      transport: ft.factory,
    });
    const p = chat.connect();
    await tick();
    ft.error("boom");
    await expect(p).rejects.toThrow("usedesk_chat_connect_error");
  });
});

describe("isRenderableMessage", () => {
  const base: ChatState["messages"][number] = {
    id: 1,
    text: "",
    createdAt: "",
    chat: 1,
    type: "operator_to_client",
    name: "",
  };
  it("is false for empty service messages", () => {
    expect(isRenderableMessage(base)).toBe(false);
  });
  it("is true with text, a file, or forms", () => {
    expect(isRenderableMessage({ ...base, text: "hi" })).toBe(true);
    expect(
      isRenderableMessage({
        ...base,
        forms: [{ name: "E", type: "email", required: false }],
      }),
    ).toBe(true);
  });
});
