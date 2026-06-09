/**
 * Usedesk Knowledge Base — headless REST client (no socket, no UI). A separate
 * concern from the chat: it authenticates with the KB `api_token` + numeric
 * `knowledgeBaseId` (NOT the chat company id) and talks plain REST to the
 * `/uapi/support/*` endpoints. Mirrors the official mobile SDK's KB surface
 * (`UseDeskSwift` UDNetworkManager): sections tree, article fetch, search,
 * view/rating telemetry, and an "this didn't help → open a ticket" flow.
 *
 * Endpoints and params are verified against the official SDK; the response
 * shapes mirror its models (untested against a live KB — bring your own
 * `knowledgeBaseId` + `apiToken`).
 *
 * ```ts
 * const kb = createKnowledgeBase({ knowledgeBaseId: 123, apiToken: "…" });
 * const sections = await kb.getSections();
 * const { articles } = await kb.searchArticles({ query: "refund" });
 * const article = await kb.getArticle(456);
 * await kb.rateArticle(456, true);          // 👍
 * ```
 */

import type { UsedeskChatLogger } from "./client.js";

const DEFAULT_KB_API_BASE = "https://secure.usedesk.ru/uapi";

export interface KnowledgeBaseOptions {
  /** Numeric knowledge base id from the Usedesk account. */
  knowledgeBaseId: string | number;
  /** Knowledge base API token (distinct from the chat company id). */
  apiToken: string;
  /** API host. Default: secure.usedesk.ru/uapi. */
  apiBase?: string;
  /** Debug sink; omit for silent operation. */
  logger?: UsedeskChatLogger;
}

/** Article stub inside the sections tree (no body). */
export interface KbArticleTitle {
  id: number;
  title: string;
  views?: number;
}

export interface KbCategory {
  id: number;
  title: string;
  description?: string;
  open?: boolean;
  articles?: KbArticleTitle[];
}

/** Top-level KB section, carrying its categories (each with article stubs). */
export interface KbSection {
  id: number;
  title: string;
  image?: string;
  open?: boolean;
  categories?: KbCategory[];
}

/** A full article (with body), as returned by getArticle / searchArticles. */
export interface KbArticle {
  id: number;
  title: string;
  /** HTML body — render as constrained rich text, never raw. */
  text: string;
  open?: boolean;
  category_id?: number;
  collection_id?: number;
  category_title?: string;
  section_title?: string;
  views?: number;
  created_at?: string;
}

export interface KbSearchResult {
  page: number;
  last_page: number;
  count: number;
  total_count: number;
  articles: KbArticle[];
}

export type KbSearchType = "all" | "public" | "private";
export type KbSearchSort =
  | "id"
  | "category_id"
  | "created_at"
  | "public"
  | "title";
export type KbSearchOrder = "asc" | "desc";

export interface KbSearchParams {
  query: string;
  /** Page size. Default 20. */
  count?: number;
  /** 1-based page. Default 1. */
  page?: number;
  collectionIds?: number[];
  categoryIds?: number[];
  articleIds?: number[];
  type?: KbSearchType;
  sort?: KbSearchSort;
  order?: KbSearchOrder;
  /** Return shortened bodies (the widget's `short_text=1`). Default true. */
  shortText?: boolean;
}

/** "This article didn't help" → opens a ticket tagged to the article. */
export interface KbArticleReview {
  articleId: number;
  subject: string;
  message: string;
  tag: string;
  email?: string;
  phone?: string;
  name?: string;
}

export class UsedeskKnowledgeBase {
  private apiBase: string;
  private kbId: string;
  private apiToken: string;
  private logger: UsedeskChatLogger | null;

  constructor(options: KnowledgeBaseOptions) {
    this.apiBase = options.apiBase ?? DEFAULT_KB_API_BASE;
    this.kbId = String(options.knowledgeBaseId);
    this.apiToken = options.apiToken;
    this.logger = options.logger ?? null;
  }

  /** Full sections → categories → article-stubs tree. */
  getSections(): Promise<KbSection[]> {
    return this.get<KbSection[]>(`/support/${this.kbId}/list`);
  }

  /** Fetch a single article with its body. */
  getArticle(articleId: number): Promise<KbArticle> {
    return this.get<KbArticle>(`/support/${this.kbId}/articles/${articleId}`);
  }

  /** Search articles (paginated). */
  searchArticles(params: KbSearchParams): Promise<KbSearchResult> {
    const body: Record<string, string | number | number[]> = {
      query: params.query,
      count: params.count ?? 20,
      page: params.page ?? 1,
      short_text: params.shortText === false ? "0" : "1",
    };
    if (params.type && params.type !== "all") body.type = params.type;
    if (params.sort) body.sort = params.sort;
    if (params.order) body.order = params.order;
    if (params.collectionIds?.length) body.collection_ids = params.collectionIds;
    if (params.categoryIds?.length) body.category_ids = params.categoryIds;
    if (params.articleIds?.length) body.article_ids = params.articleIds;
    return this.post<KbSearchResult>(
      `/support/${this.kbId}/articles/list`,
      body,
    );
  }

  /** Increment an article's view counter. */
  async addArticleView(articleId: number, count = 1): Promise<void> {
    await this.post(`/support/${this.kbId}/articles/${articleId}/add-views`, {
      count,
    });
  }

  /** Rate an article helpful (👍) or not (👎). */
  async rateArticle(articleId: number, helpful: boolean): Promise<void> {
    await this.post(
      `/support/${this.kbId}/articles/${articleId}/change-rating`,
      helpful ? { count_positive: 1 } : { count_negative: 1 },
    );
  }

  /** Open a ticket from a "this didn't help" review of an article. */
  async sendArticleReview(review: KbArticleReview): Promise<void> {
    const body: Record<string, string | number> = {
      subject: review.subject,
      message: `${review.message}\nid ${review.articleId}`,
      tag: review.tag,
    };
    if (review.email) body.client_email = review.email;
    if (review.phone) body.client_phone = review.phone;
    if (review.name) body.client_name = review.name;
    await this.post(`/create/ticket`, body);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const url = `${this.apiBase}${path}?api_token=${encodeURIComponent(this.apiToken)}`;
    const res = await fetch(url, { method: "GET" });
    return this.parse<T>(res, path);
  }

  private async post<T>(
    path: string,
    params: Record<string, string | number | number[]>,
  ): Promise<T> {
    const form = new URLSearchParams();
    form.append("api_token", this.apiToken);
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        // Alamofire URLEncoding array convention: `key[]=v`.
        for (const v of value) form.append(`${key}[]`, String(v));
      } else {
        form.append(key, String(value));
      }
    }
    const res = await fetch(`${this.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    return this.parse<T>(res, path);
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const data = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || data == null) {
      this.logger?.error("kb_request_failed", { path, status: res.status });
      throw new Error(`usedesk_kb_request_failed: ${res.status} ${path}`);
    }
    return data;
  }
}

export const createKnowledgeBase = (options: KnowledgeBaseOptions) =>
  new UsedeskKnowledgeBase(options);
