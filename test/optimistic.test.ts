import { beforeEach, describe, expect, it } from "bun:test";

import { UsedeskChatClient } from "../src/client.js";
import type { ChatMessage } from "../src/protocol.js";
import {
  addMessageAction,
  initedAction,
  installStorage,
  makeFakeTransport,
  tick,
  type FakeTransport,
} from "./helpers.js";

async function connectOptimistic() {
  const ft = makeFakeTransport();
  const chat = new UsedeskChatClient({
    companyId: "1_2",
    pubsubUrl: "https://x",
    transport: ft.factory,
    optimistic: true,
  });
  const p = chat.connect();
  await tick();
  ft.emit(initedAction());
  await p;
  return { ft, chat };
}

const sentText = (ft: FakeTransport) =>
  ft.sent.filter((a) => a.type === "@@server/chat/SEND_MESSAGE");

describe("optimistic send", () => {
  beforeEach(() => {
    installStorage();
  });

  it("is off by default: plain SEND_MESSAGE, no local message", async () => {
    const ft = makeFakeTransport();
    const chat = new UsedeskChatClient({
      companyId: "1_2",
      pubsubUrl: "https://x",
      transport: ft.factory,
    });
    const p = chat.connect();
    await tick();
    ft.emit(initedAction());
    await p;
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    chat.sendMessage("hi");
    expect(got).toHaveLength(0); // nothing rendered optimistically
    const sent = sentText(ft)[0] as { message: Record<string, unknown> };
    expect(sent.message.text).toBe("hi");
    expect(sent.message.payload).toBeUndefined();
    chat.dispose();
  });

  it("renders immediately with sending status + message_id", async () => {
    const { ft, chat } = await connectOptimistic();
    const got: ChatMessage[] = [];
    chat.on("message", (m) => got.push(m));
    chat.sendMessage("hello");
    expect(got).toHaveLength(1);
    expect(got[0]?.sendStatus).toBe("sending");
    expect(got[0]?.localId).toBeTruthy();
    const sent = sentText(ft)[0] as {
      message: { text: string; payload: { message_id: string } };
    };
    expect(sent.message.payload.message_id).toBe(got[0]?.localId);
    chat.dispose();
  });

  it("reconciles the echo by message_id (no duplicate, status sent)", async () => {
    const { ft, chat } = await connectOptimistic();
    const got: ChatMessage[] = [];
    const updates: Array<{ localId: string; message: ChatMessage }> = [];
    chat.on("message", (m) => got.push(m));
    chat.on("messageUpdate", (u) => updates.push(u));
    chat.sendMessage("hello");
    const localId = got[0]?.localId as string;

    // server echoes ADD_MESSAGE carrying our message_id back
    ft.emit(
      addMessageAction({
        id: 555,
        text: "hello",
        type: "client_to_operator",
        payload: { message_id: localId },
      }),
    );
    expect(got).toHaveLength(1); // echo did NOT append a second message
    expect(updates).toHaveLength(1);
    expect(updates[0]?.message.id).toBe(555);
    expect(updates[0]?.message.sendStatus).toBe("sent");
    expect(chat.chatState?.messages).toHaveLength(1);
    chat.dispose();
  });

  it("marks failed when the socket is down, then retry re-sends", async () => {
    const { ft, chat } = await connectOptimistic();
    const updates: ChatMessage[] = [];
    chat.on("messageUpdate", (u) => updates.push(u.message));
    ft.disconnect(); // socket drops → transport.send returns false
    chat.sendMessage("offline");
    expect(updates.at(-1)?.sendStatus).toBe("failed");
    const localId = updates.at(-1)?.localId as string;

    ft.reconnect(); // socket back up
    chat.retry(localId);
    expect(updates.at(-1)?.sendStatus).toBe("sending");
    chat.dispose();
  });
});
