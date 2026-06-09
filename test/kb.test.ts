import { beforeEach, describe, expect, it } from "bun:test";

import { createKnowledgeBase } from "../src/kb.js";
import { mockFetch, type FetchMock } from "./helpers.js";

const parseBody = (init: RequestInit | undefined): URLSearchParams =>
  new URLSearchParams(String(init?.body ?? ""));

describe("UsedeskKnowledgeBase", () => {
  let f: FetchMock;
  const kb = () =>
    createKnowledgeBase({ knowledgeBaseId: 123, apiToken: "tkn" });

  beforeEach(() => {
    f = mockFetch();
    f.setResponder(() => ({ ok: true, status: 200, json: {} }));
  });

  it("getSections → GET /support/{id}/list with the api_token", async () => {
    f.setResponder(() => ({ ok: true, json: [{ id: 1, title: "S" }] }));
    const sections = await kb().getSections();
    expect(sections).toEqual([{ id: 1, title: "S" }] as never);
    expect(f.calls[0]?.url).toBe(
      "https://secure.usedesk.ru/uapi/support/123/list?api_token=tkn",
    );
    expect(f.calls[0]?.init?.method).toBe("GET");
  });

  it("getArticle → GET /support/{id}/articles/{articleId}", async () => {
    f.setResponder(() => ({ ok: true, json: { id: 9, title: "A", text: "" } }));
    const a = await kb().getArticle(9);
    expect(a.id).toBe(9);
    expect(f.calls[0]?.url).toBe(
      "https://secure.usedesk.ru/uapi/support/123/articles/9?api_token=tkn",
    );
  });

  it("searchArticles → POST form-urlencoded with arrays as key[]", async () => {
    f.setResponder(() => ({ ok: true, json: { articles: [] } }));
    await kb().searchArticles({
      query: "refund",
      collectionIds: [1, 2],
      type: "public",
    });
    const call = f.calls[0];
    expect(call?.url).toBe(
      "https://secure.usedesk.ru/uapi/support/123/articles/list",
    );
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = parseBody(call?.init);
    expect(body.get("api_token")).toBe("tkn");
    expect(body.get("query")).toBe("refund");
    expect(body.get("short_text")).toBe("1");
    expect(body.get("type")).toBe("public");
    expect(body.getAll("collection_ids[]")).toEqual(["1", "2"]);
  });

  it("rateArticle(true) sends count_positive, (false) count_negative", async () => {
    await kb().rateArticle(5, true);
    expect(parseBody(f.calls[0]?.init).get("count_positive")).toBe("1");
    await kb().rateArticle(5, false);
    expect(parseBody(f.calls[1]?.init).get("count_negative")).toBe("1");
    expect(f.calls[0]?.url).toContain("/articles/5/change-rating");
  });

  it("addArticleView posts the view count", async () => {
    await kb().addArticleView(7, 3);
    expect(f.calls[0]?.url).toContain("/articles/7/add-views");
    expect(parseBody(f.calls[0]?.init).get("count")).toBe("3");
  });

  it("sendArticleReview opens a ticket tagged with the article id", async () => {
    await kb().sendArticleReview({
      articleId: 42,
      subject: "S",
      message: "did not help",
      tag: "kb",
      email: "a@b.c",
    });
    expect(f.calls[0]?.url).toBe(
      "https://secure.usedesk.ru/uapi/create/ticket",
    );
    const body = parseBody(f.calls[0]?.init);
    expect(body.get("message")).toContain("id 42");
    expect(body.get("client_email")).toBe("a@b.c");
  });

  it("throws on a non-ok response", async () => {
    f.setResponder(() => ({ ok: false, status: 404, json: null }));
    await expect(kb().getArticle(1)).rejects.toThrow(
      "usedesk_kb_request_failed",
    );
  });
});
