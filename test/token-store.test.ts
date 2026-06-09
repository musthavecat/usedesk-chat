import { beforeEach, describe, expect, it } from "bun:test";

import { clearToken, getStoredToken, storeToken } from "../src/token-store.js";
import { installStorage } from "./helpers.js";

describe("token-store", () => {
  beforeEach(() => {
    installStorage();
  });

  it("returns null when nothing is stored", () => {
    expect(getStoredToken()).toBeNull();
  });

  it("persists a token to both cookie and localStorage", () => {
    storeToken("abc");
    expect(getStoredToken()).toBe("abc");
    const raw = localStorage.getItem("usedesk_messenger_token");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).data).toBe("abc");
  });

  it("reads the cookie first (script-widget compatibility)", () => {
    storeToken("from-store");
    // Simulate a cookie written by the official widget for the same key.
    document.cookie = "usedesk_messenger_token=cookie-wins; path=/";
    expect(getStoredToken()).toBe("cookie-wins");
  });

  it("clears both stores", () => {
    storeToken("abc");
    clearToken();
    expect(getStoredToken()).toBeNull();
    expect(localStorage.getItem("usedesk_messenger_token")).toBeNull();
  });
});
