import { describe, expect, it } from "bun:test";

import { hasFormMarkup, parseFormMessage } from "../src/forms.js";

describe("parseFormMessage", () => {
  it("returns the text untouched when there is no marker", () => {
    const r = parseFormMessage("hello world");
    expect(r.text).toBe("hello world");
    expect(r.forms).toEqual([]);
  });

  it("handles empty / falsy input", () => {
    expect(parseFormMessage("")).toEqual({ text: "", forms: [] });
  });

  it("parses a single required email field and strips the markup", () => {
    const r = parseFormMessage("Please fill {{form;Email;email;true}} thanks");
    expect(r.forms).toEqual([{ name: "Email", type: "email", required: true }]);
    expect(r.text).not.toContain("{{form");
    expect(r.text).toContain("Please fill");
    expect(r.text).toContain("thanks");
  });

  it("defaults required to false when the segment is absent", () => {
    const r = parseFormMessage("{{form;Email;email}}");
    expect(r.forms).toEqual([{ name: "Email", type: "email", required: false }]);
    expect(r.text).toBe("");
  });

  it("parses multiple forms in one message", () => {
    const r = parseFormMessage("{{form;Name;name;true}}{{form;Email;email}}");
    expect(r.forms).toEqual([
      { name: "Name", type: "name", required: true },
      { name: "Email", type: "email", required: false },
    ]);
    expect(r.text).toBe("");
  });

  it("maps a numeric type to an additionalField with a fieldId", () => {
    const r = parseFormMessage("{{form;Custom;42;true}}");
    expect(r.forms).toEqual([
      { name: "Custom", type: "additionalField", fieldId: 42, required: true },
    ]);
  });

  it("rejects a bare additionalField (no id) and leaves its markup", () => {
    const r = parseFormMessage("{{form;X;additionalField;true}}");
    expect(r.forms).toEqual([]);
    expect(r.text).toContain("{{form");
  });

  it("rejects an unknown type", () => {
    expect(parseFormMessage("{{form;X;banana}}").forms).toEqual([]);
  });

  it("rejects an empty field name", () => {
    expect(parseFormMessage("{{form;;email}}").forms).toEqual([]);
  });

  it("keeps non-form text when a form is mixed in", () => {
    const r = parseFormMessage("a {{form;Email;email}} b");
    expect(r.forms).toHaveLength(1);
    expect(r.text).toContain("a");
    expect(r.text).toContain("b");
  });
});

describe("hasFormMarkup", () => {
  it("detects the marker", () => {
    expect(hasFormMarkup("x {{form;A;email}}")).toBe(true);
  });
  it("is false for plain text / empty", () => {
    expect(hasFormMarkup("nope")).toBe(false);
    expect(hasFormMarkup("")).toBe(false);
  });
});
