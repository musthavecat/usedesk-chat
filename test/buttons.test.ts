import { describe, expect, it } from "bun:test";

import { hasButtonMarkup, parseButtonsMessage } from "../src/buttons.js";

describe("parseButtonsMessage", () => {
  it("returns text untouched without a marker", () => {
    expect(parseButtonsMessage("hi")).toEqual({ text: "hi", buttons: [] });
  });

  it("parses a link button with target and strips the markup", () => {
    const r = parseButtonsMessage(
      "Open {{button:Docs;https://usedesk.com;blank;show}} now",
    );
    expect(r.buttons).toEqual([
      { title: "Docs", url: "https://usedesk.com", target: "blank", visible: true },
    ]);
    expect(r.text).not.toContain("{{button");
    expect(r.text).toContain("Open");
    expect(r.text).toContain("now");
  });

  it("defaults target to self and visible to true", () => {
    const r = parseButtonsMessage("{{button:Reply}}");
    expect(r.buttons).toEqual([
      { title: "Reply", url: "", target: "self", visible: true },
    ]);
  });

  it("honours the noshow visibility flag", () => {
    const r = parseButtonsMessage("{{button:Hidden;;;noshow}}");
    expect(r.buttons[0]?.visible).toBe(false);
  });

  it("parses several buttons", () => {
    const r = parseButtonsMessage("{{button:A}}{{button:B;https://b}}");
    expect(r.buttons.map((b) => b.title)).toEqual(["A", "B"]);
    expect(r.buttons[1]?.url).toBe("https://b");
  });

  it("rejects an empty title", () => {
    expect(parseButtonsMessage("{{button:}}").buttons).toEqual([]);
  });

  it("does not touch form markup", () => {
    const r = parseButtonsMessage("{{form;Email;email;true}}");
    expect(r.buttons).toEqual([]);
    expect(r.text).toContain("{{form");
  });
});

describe("hasButtonMarkup", () => {
  it("detects the colon marker", () => {
    expect(hasButtonMarkup("x {{button:A}}")).toBe(true);
    expect(hasButtonMarkup("{{form;A;email}}")).toBe(false);
    expect(hasButtonMarkup("")).toBe(false);
  });
});
