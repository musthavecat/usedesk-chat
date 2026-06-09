import { beforeEach, describe, expect, it } from "bun:test";

import {
  cachedDiscoverConfig,
  discoverConfig,
  widgetBundleUrl,
} from "../src/discovery.js";
import { installStorage, mockFetch } from "./helpers.js";

const BUNDLE_TAIL = `
  window.__cfg = {
    pubsubUrl: "https://pubsubsec4.usedesk.ru",
    centrifugoEnabled: "",
    apiDomain: "https://secure.usedesk.ru/uapi/v1",
    fileUploadUrl: "https://secure.usedesk.ru/uapi/v1/safely_send_file"
  };
`;

describe("widgetBundleUrl", () => {
  it("builds the S3 bundle url", () => {
    expect(widgetBundleUrl("172315_70529")).toBe(
      "https://s3.usedesk.ru/lib/secure.usedesk.ru/widget_172315_70529.js",
    );
  });
});

describe("discoverConfig", () => {
  beforeEach(() => {
    installStorage();
  });

  it("range-fetches the bundle tail and parses the config", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: true, status: 206, text: BUNDLE_TAIL }));
    const cfg = await discoverConfig("1_2");
    expect(cfg.pubsubUrl).toBe("https://pubsubsec4.usedesk.ru");
    expect(cfg.apiDomain).toBe("https://secure.usedesk.ru/uapi/v1");
    expect(cfg.centrifugoEnabled).toBe(false);
    // direct fetch sends a Range header
    expect(f.calls[0]?.init?.headers).toMatchObject({ Range: "bytes=-8192" });
  });

  it("appends companyId to a proxy url and accepts JSON", async () => {
    const f = mockFetch();
    f.setResponder(() => ({
      ok: true,
      status: 200,
      text: '{"pubsubUrl":"https://proxy.host"}',
    }));
    const cfg = await discoverConfig("9_9", { url: "/api/cfg" });
    expect(cfg.pubsubUrl).toBe("https://proxy.host");
    expect(f.calls[0]?.url).toBe("/api/cfg?companyId=9_9");
  });

  it("throws on a hard HTTP failure", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: false, status: 500, text: "" }));
    await expect(discoverConfig("1_2")).rejects.toThrow(
      "usedesk_chat_discovery_failed",
    );
  });
});

describe("cachedDiscoverConfig", () => {
  beforeEach(() => {
    installStorage();
  });

  it("caches a successful discovery (one fetch for two calls)", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: true, status: 206, text: BUNDLE_TAIL }));
    const a = await cachedDiscoverConfig("1_2");
    const b = await cachedDiscoverConfig("1_2");
    expect(a?.pubsubUrl).toBe("https://pubsubsec4.usedesk.ru");
    expect(b?.pubsubUrl).toBe("https://pubsubsec4.usedesk.ru");
    expect(f.calls).toHaveLength(1);
  });

  it("returns null (never throws) on failure", async () => {
    const f = mockFetch();
    f.setResponder(() => ({ ok: false, status: 503, text: "" }));
    expect(await cachedDiscoverConfig("err_1")).toBeNull();
  });
});
