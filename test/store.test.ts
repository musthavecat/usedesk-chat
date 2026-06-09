import { beforeEach, describe, expect, it } from "bun:test";

import { createChatStore } from "../src/store.js";
import {
  addMessageAction,
  initedAction,
  installStorage,
  makeFakeTransport,
  tick,
} from "./helpers.js";

async function readyStore(over: Record<string, unknown> = {}) {
  const ft = makeFakeTransport();
  const store = createChatStore({
    companyId: "1_2",
    pubsubUrl: "https://x",
    transport: ft.factory,
  });
  const p = store.connect();
  await tick();
  ft.emit(initedAction(over));
  await p;
  return { ft, store };
}

describe("createChatStore", () => {
  beforeEach(() => {
    installStorage();
  });

  it("flips to ready and carries INITED fields into the snapshot", async () => {
    const { store } = await readyStore({
      noOperators: true,
      callback_settings: { x: 1 },
    });
    const s = store.getSnapshot();
    expect(s.status).toBe("ready");
    expect(s.hasIdentity).toBe(true);
    expect(s.noOperators).toBe(true);
    expect(s.callbackSettings).toEqual({ x: 1 });
    store.dispose();
  });

  it("appends incoming messages immutably", async () => {
    const { ft, store } = await readyStore();
    const before = store.getSnapshot().messages;
    ft.emit(addMessageAction({ id: 2, text: "yo" }));
    const after = store.getSnapshot().messages;
    expect(after).not.toBe(before);
    expect(after.at(-1)?.text).toBe("yo");
    store.dispose();
  });

  it("records optimistic feedback in the snapshot", async () => {
    const { store } = await readyStore();
    store.sendFeedback(5, true);
    expect(store.getSnapshot().feedback).toEqual({ 5: "like" });
    store.sendFeedback(6, false);
    expect(store.getSnapshot().feedback).toEqual({ 5: "like", 6: "dislike" });
    store.dispose();
  });

  it("resetSession clears chat state", async () => {
    const { store } = await readyStore({ noOperators: true });
    store.resetSession();
    const s = store.getSnapshot();
    expect(s.status).toBe("idle");
    expect(s.hasIdentity).toBe(false);
    expect(s.noOperators).toBe(false);
    expect(s.feedback).toEqual({});
    store.dispose();
  });

  it("connect resolves false when the transport errors", async () => {
    const ft = makeFakeTransport();
    const store = createChatStore({
      companyId: "1_2",
      pubsubUrl: "https://x",
      transport: ft.factory,
    });
    const p = store.connect();
    await tick();
    ft.error("down");
    expect(await p).toBe(false);
    expect(store.getSnapshot().status).toBe("error");
    store.dispose();
  });
});
