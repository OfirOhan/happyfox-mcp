import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HappyFoxClient,
  resolveBaseUrl,
  ticketNumber,
  buildTicketQuery,
  summarizeTickets,
  conversation,
  compactContact,
  stripEmpty,
} from "../dist/client.js";

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const { status = 200, body = {} } = (await responder(url, init)) ?? {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

test("resolves account names, hosts and custom domains to the API base URL", () => {
  assert.equal(resolveBaseUrl("acme"), "https://acme.happyfox.com/api/1.1/json");
  assert.equal(resolveBaseUrl("acme.happyfox.net"), "https://acme.happyfox.net/api/1.1/json");
  assert.equal(resolveBaseUrl("https://help.acme.com/"), "https://help.acme.com/api/1.1/json");
  assert.equal(resolveBaseUrl("https://acme.happyfox.com/api/1.1/json"), "https://acme.happyfox.com/api/1.1/json");
});

test("sends HTTP Basic auth with key and auth code", async () => {
  const f = mockFetch(() => ({ body: [{ id: 1, name: "Support" }] }));
  const c = new HappyFoxClient({ apiKey: "key", authCode: "code", domain: "acme", fetch: f });
  await c.categories();
  assert.equal(f.calls[0].url, "https://acme.happyfox.com/api/1.1/json/categories/");
  assert.equal(f.calls[0].headers.Authorization, `Basic ${Buffer.from("key:code").toString("base64")}`);
});

test("parses ticket numbers and display IDs", () => {
  assert.equal(ticketNumber(42), 42);
  assert.equal(ticketNumber("#DC00000042"), 42);
  assert.equal(ticketNumber("17"), 17);
  assert.throws(() => ticketNumber("abc"));
});

test("builds HappyFox search strings", () => {
  assert.equal(
    buildTicketQuery({ statuses: ["New", "On Hold"], priorities: ["High"], created_after: "2026-10-01", assignee: "none" }),
    'status:"New","On Hold" priority:"High" assignee:none created-on-or-after:"2026/10/01"',
  );
  assert.equal(buildTicketQuery({}), undefined);
});

test("ticket list sends q, status and paging as query params", async () => {
  const f = mockFetch(() => ({ body: { page_info: { count: 0 }, data: [] } }));
  const c = new HappyFoxClient({ apiKey: "k", authCode: "c", baseUrl: "http://x/api/1.1/json", fetch: f });
  await c.listTickets({ status: "_all", q: 'priority:"High"', size: 20, page: undefined });
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, "/api/1.1/json/tickets/");
  assert.equal(u.searchParams.get("q"), 'priority:"High"');
  assert.equal(u.searchParams.get("status"), "_all");
  assert.equal(u.searchParams.has("page"), false);
});

test("POST bodies drop undefined but keep null (unassign)", async () => {
  const f = mockFetch(() => ({ body: { id: 5 } }));
  const c = new HappyFoxClient({ apiKey: "k", authCode: "c", domain: "acme", fetch: f });
  await c.staffUpdate(5, { staff: 1, assignee: null, status: undefined, tags: [] });
  assert.equal(f.calls[0].method, "POST");
  assert.ok(f.calls[0].url.endsWith("/ticket/5/staff_update/"));
  assert.deepEqual(JSON.parse(f.calls[0].body), { staff: 1, assignee: null });
  assert.deepEqual(stripEmpty({ a: undefined, b: { c: 1 } }), { b: { c: 1 } });
});

test("surfaces API errors with status and body", async () => {
  const f = mockFetch(() => ({ status: 400, body: { error: [{ field: "category", errors: ["This field is required."] }] } }));
  const c = new HappyFoxClient({ apiKey: "k", authCode: "c", domain: "acme", fetch: f });
  await assert.rejects(() => c.createTicket({}), /HappyFox API 400 .*category/);
});

test("summarizes tickets and flattens the conversation", () => {
  const tickets = [
    { id: 1, status: { name: "New" }, priority: { name: "High" }, assigned_to: null, unresponded: true, sla_breaches: 1 },
    { id: 2, status: { name: "New" }, priority: { name: "Low" }, assigned_to: { name: "Dana" }, unresponded: false, sla_breaches: 0 },
  ];
  const s = summarizeTickets(tickets);
  assert.deepEqual(s.byStatus, { New: 2 });
  assert.deepEqual(s.byAssignee, { unassigned: 1, Dana: 1 });
  assert.equal(s.unresponded, 1);
  assert.equal(s.breachedSla, 1);

  const conv = conversation({
    updates: [
      {
        timestamp: "2026-10-08 09:00:00",
        by: { name: "Jo", type: "user" },
        message: { text: "My export is broken", attachments: [{ filename: "a.png" }] },
        status_change: null,
      },
      { timestamp: "2026-10-08 10:00:00", by: { name: "Dana", type: "staff" }, message: null, status_change: { old_name: "New", new_name: "In Progress" } },
    ],
  });
  assert.equal(conv[0].text, "My export is broken");
  assert.deepEqual(conv[0].attachments, ["a.png"]);
  assert.equal(conv[1].changes.status, "New -> In Progress");
});

test("compacts contacts", () => {
  const c = compactContact({
    id: 4,
    name: "John",
    email: "john@example.com",
    phones: [{ number: "123" }],
    contact_groups: [{ name: "Acme" }],
    tickets_count: 2,
    custom_fields: [{ name: "Plan", value: "Pro" }, { name: "Empty", value: null }],
  });
  assert.deepEqual(c.phones, ["123"]);
  assert.deepEqual(c.groups, ["Acme"]);
  assert.deepEqual(c.custom_fields, { Plan: "Pro" });
});
