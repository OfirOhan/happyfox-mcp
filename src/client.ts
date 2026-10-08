/**
 * Minimal typed client for the HappyFox Help Desk REST API (v1.1).
 * Docs: https://support.happyfox.com/kb/article/1039-happyfox-api-documentation/
 *
 * Auth: HTTP Basic, API key as the username and auth code as the password.
 * Base URL: https://<account>.happyfox.com/api/1.1/json (EU accounts use .happyfox.net,
 * custom domains use the custom domain).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HappyFoxClientOptions {
  apiKey: string;
  authCode: string;
  /** e.g. "acme.happyfox.com", "https://support.acme.com" or a full .../api/1.1/json URL */
  domain?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export type Record_ = Record<string, unknown>;
export type Query = Record<string, string | number | boolean | undefined>;

export class HappyFoxApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`HappyFox API ${status} on ${path}: ${body.slice(0, 500)}`);
    this.name = "HappyFoxApiError";
  }
}

/** Turn "acme", "acme.happyfox.com" or "https://help.acme.com/" into the API base URL. */
export function resolveBaseUrl(domain: string): string {
  let d = domain.trim().replace(/\/+$/, "");
  if (/\/api\/1\.1\/json$/.test(d)) return d.startsWith("http") ? d : `https://${d}`;
  if (!d.includes(".") && !d.startsWith("http")) d = `${d}.happyfox.com`;
  if (!/^https?:\/\//.test(d)) d = `https://${d}`;
  return `${d}/api/1.1/json`;
}

/** Accepts 42, "42", "#DC00000042" or "DC00000042" and returns the ticket number 42. */
export function ticketNumber(v: string | number): number {
  if (typeof v === "number") return v;
  const m = /(\d+)\s*$/.exec(v.trim());
  if (!m) throw new Error(`Not a ticket number or ID: ${v}`);
  return Number(m[1]);
}

export function stripEmpty<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripEmpty) as T;
  if (v && typeof v === "object") {
    const out: Record_ = {};
    for (const [k, val] of Object.entries(v as Record_)) {
      if (val === undefined) continue;
      if (Array.isArray(val) && val.length === 0) continue;
      out[k] = stripEmpty(val);
    }
    return out as T;
  }
  return v;
}

export class HappyFoxClient {
  private headers: Record<string, string>;
  readonly baseUrl: string;
  private fetchImpl: FetchLike;

  constructor(opts: HappyFoxClientOptions) {
    if (!opts.apiKey || !opts.authCode) throw new Error("A HappyFox API key and auth code are required.");
    if (!opts.baseUrl && !opts.domain) throw new Error("Set your HappyFox domain, e.g. acme.happyfox.com.");
    const token = Buffer.from(`${opts.apiKey}:${opts.authCode}`).toString("base64");
    this.headers = { Authorization: `Basic ${token}`, "Content-Type": "application/json", Accept: "application/json" };
    this.baseUrl = (opts.baseUrl ?? resolveBaseUrl(opts.domain!)).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    let url = this.baseUrl + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== "") qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers,
      body: opts.body !== undefined ? JSON.stringify(stripEmpty(opts.body)) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new HappyFoxApiError(res.status, text, path);
    if (!text) return { ok: true } as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { message: text } as T;
    }
  }

  // Reference data
  categories() {
    return this.request<Record_[]>("GET", "/categories/");
  }
  statuses() {
    return this.request<Record_[]>("GET", "/statuses/");
  }
  priorities() {
    return this.request<Record_[]>("GET", "/priorities/");
  }
  staff() {
    return this.request<Record_[]>("GET", "/staff/");
  }
  ticketCustomFields() {
    return this.request<Record_[]>("GET", "/ticket_custom_fields/");
  }
  contactCustomFields() {
    return this.request<Record_[]>("GET", "/user_custom_fields/");
  }

  // Tickets
  listTickets(query: Query) {
    return this.request<{ page_info?: Record_; data?: Record_[] }>("GET", "/tickets/", { query });
  }
  getTicket(n: number) {
    return this.request<Record_>("GET", `/ticket/${n}/`);
  }
  createTicket(body: Record_) {
    return this.request<Record_>("POST", "/tickets/", { body });
  }
  staffUpdate(n: number, body: Record_) {
    return this.request<Record_>("POST", `/ticket/${n}/staff_update/`, { body });
  }
  privateNote(n: number, body: Record_) {
    return this.request<Record_>("POST", `/ticket/${n}/staff_pvtnote/`, { body });
  }
  updateTags(n: number, body: { add?: string; remove?: string; staff_id: number }) {
    return this.request<Record_>("POST", `/ticket/${n}/update_tags/`, { body });
  }
  moveTicket(n: number, body: Record_) {
    return this.request<Record_>("POST", `/ticket/${n}/move/`, { body });
  }

  // Contacts
  listContacts(query: Query) {
    return this.request<{ page_info?: Record_; data?: Record_[] }>("GET", "/users/", { query });
  }
  getContact(idOrEmail: string | number) {
    return this.request<Record_>("GET", `/user/${encodeURIComponent(String(idOrEmail))}/`);
  }
  createContact(body: Record_) {
    return this.request<Record_>("POST", "/users/", { body });
  }
  updateContact(id: number, body: Record_) {
    return this.request<Record_>("POST", `/user/${id}/`, { body });
  }
  contactGroups() {
    return this.request<Record_[]>("GET", "/contact_groups/");
  }
}

/** Build HappyFox's search string, e.g. status:"New","On Hold" priority:"High" created-on-or-after:"2026/10/01". */
export function buildTicketQuery(f: {
  statuses?: string[];
  priorities?: string[];
  assignee?: string;
  contact?: string;
  tags?: string[];
  unresponded?: boolean;
  breached?: boolean;
  due?: string;
  created_after?: string;
  created_before?: string;
  modified_after?: string;
  text?: string;
}): string | undefined {
  const list = (xs: string[]) => xs.map((x) => `"${x}"`).join(",");
  const day = (iso: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[1]}/${m[2]}/${m[3]}` : iso;
  };
  const parts: string[] = [];
  if (f.statuses?.length) parts.push(`status:${list(f.statuses)}`);
  if (f.priorities?.length) parts.push(`priority:${list(f.priorities)}`);
  if (f.assignee) parts.push(`assignee:${f.assignee}`);
  if (f.contact) parts.push(`contact:"${f.contact}"`);
  if (f.tags?.length) parts.push(`tag:${list(f.tags)}`);
  if (f.unresponded !== undefined) parts.push(`unresponded:${f.unresponded}`);
  if (f.breached !== undefined) parts.push(`breached:${f.breached}`);
  if (f.due) parts.push(`duedate:${f.due}`);
  if (f.created_after) parts.push(`created-on-or-after:"${day(f.created_after)}"`);
  if (f.created_before) parts.push(`created-before:"${day(f.created_before)}"`);
  if (f.modified_after) parts.push(`last-modified-on-or-after:"${day(f.modified_after)}"`);
  if (f.text) parts.push(f.text);
  return parts.length ? parts.join(" ") : undefined;
}

const name = (v: unknown) => (v && typeof v === "object" ? ((v as Record_).name as string | undefined) : undefined);

export function compactTicket(t: Record_) {
  const user = (t.user as Record_ | undefined) ?? {};
  return {
    number: t.id,
    display_id: t.display_id,
    subject: t.subject,
    status: name(t.status),
    priority: name(t.priority),
    category: name(t.category),
    assignee: name(t.assigned_to) ?? null,
    contact: user.name,
    contact_email: user.email,
    tags: t.tags || undefined,
    due_date: t.due_date ?? undefined,
    unresponded: t.unresponded,
    sla_breaches: t.sla_breaches,
    messages: t.messages_count,
    created_at: t.created_at,
    last_user_reply_at: t.last_user_reply_at,
    last_staff_reply_at: t.last_staff_reply_at,
    last_modified: t.last_modified,
  };
}

/** Counts by status, priority and assignee, so an agent can answer "what's on fire" without paging. */
export function summarizeTickets(tickets: Record_[]) {
  const by = (key: (t: ReturnType<typeof compactTicket>) => unknown) => {
    const out: Record<string, number> = {};
    for (const t of tickets.map(compactTicket)) {
      const k = String(key(t) ?? "none");
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  return {
    byStatus: by((t) => t.status),
    byPriority: by((t) => t.priority),
    byAssignee: by((t) => t.assignee ?? "unassigned"),
    unresponded: tickets.filter((t) => t.unresponded === true).length,
    breachedSla: tickets.filter((t) => Number(t.sla_breaches ?? 0) > 0).length,
  };
}

/** Flatten a ticket's update history into a readable conversation. */
export function conversation(t: Record_, maxChars = 2000) {
  const updates = (t.updates as Record_[] | undefined) ?? [];
  return updates.map((u) => {
    const by = (u.by as Record_ | undefined) ?? {};
    const msg = (u.message as Record_ | undefined) ?? undefined;
    const changes: Record<string, string> = {};
    for (const k of ["status_change", "priority_change", "assignee_change", "category_change"] as const) {
      const c = u[k] as Record_ | null | undefined;
      if (c) changes[k.replace("_change", "")] = `${c.old_name ?? c.old ?? ""} -> ${c.new_name ?? c.new ?? ""}`;
    }
    const text = msg ? String(msg.text ?? "").trim() : "";
    return {
      at: u.timestamp,
      by: by.name,
      by_type: by.type,
      private_note: msg ? msg.message_type === "p" || msg.private === true || undefined : undefined,
      text: text ? (text.length > maxChars ? `${text.slice(0, maxChars)}...` : text) : undefined,
      attachments: msg && Array.isArray(msg.attachments) && msg.attachments.length ? (msg.attachments as Record_[]).map((a) => a.filename) : undefined,
      changes: Object.keys(changes).length ? changes : undefined,
    };
  });
}

export function compactContact(c: Record_) {
  const phones = (c.phones as Record_[] | undefined) ?? [];
  const groups = (c.contact_groups as Record_[] | undefined) ?? [];
  const cfs = (c.custom_fields as Record_[] | undefined) ?? [];
  const custom: Record_ = {};
  for (const f of cfs) if (f.value !== null && f.value !== undefined && f.value !== "") custom[String(f.name)] = f.value;
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phones: phones.map((p) => p.number),
    groups: groups.map((g) => g.name),
    tickets: c.tickets_count,
    pending_tickets: c.pending_tickets_count,
    custom_fields: Object.keys(custom).length ? custom : undefined,
    created_at: c.created_at ?? undefined,
  };
}
