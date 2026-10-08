// End-to-end: start the real MCP server over stdio against a local fake HappyFox API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const P = "/api/1.1/json";

function fakeHappyFox() {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      const send = (x) => res.end(JSON.stringify(x));
      const path = req.url.split("?")[0];
      if (path === `${P}/categories/`) return send([{ id: 1, name: "Support", public: true }]);
      if (path === `${P}/statuses/`) return send([{ id: 1, name: "New", behavior: "pending" }, { id: 4, name: "Completed", behavior: "completed" }]);
      if (path === `${P}/priorities/`) return send([{ id: 3, name: "High" }]);
      if (path === `${P}/staff/`) return send([{ id: 7, name: "Dana", email: "dana@acme.com", active: true, role: { name: "Agent" } }]);
      if (path === `${P}/tickets/` && req.method === "GET") {
        return send({
          page_info: { count: 2, page_count: 1 },
          data: [
            { id: 11, display_id: "#SUP00000011", subject: "Export broken", status: { name: "New" }, priority: { name: "High" }, assigned_to: null, user: { name: "Jo", email: "jo@x.com" }, unresponded: true, sla_breaches: 1 },
            { id: 12, display_id: "#SUP00000012", subject: "Billing", status: { name: "New" }, priority: { name: "High" }, assigned_to: { name: "Dana" }, user: { name: "Al", email: "al@x.com" }, unresponded: false, sla_breaches: 0 },
          ],
        });
      }
      if (path === `${P}/ticket/11/staff_update/` && req.method === "POST") {
        return send({ id: 11, display_id: "#SUP00000011", subject: "Export broken", status: { name: "Completed" }, priority: { name: "High" } });
      }
      res.statusCode = 404;
      send({ error: "Not found" });
    });
  });
  return { srv, seen };
}

function rpcClient(child) {
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  return {
    request(method, params) {
      const myId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        pending.set(myId, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

test("MCP handshake, tool listing, triage search and a reply that closes a ticket", async () => {
  const { srv, seen } = fakeHappyFox();
  srv.listen(0);
  await once(srv, "listening");
  const port = srv.address().port;

  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      HAPPYFOX_API_KEY: "key_test",
      HAPPYFOX_AUTH_CODE: "code_test",
      HAPPYFOX_BASE_URL: `http://127.0.0.1:${port}${P}`,
      HAPPYFOX_STAFF_ID: "7",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const rpc = rpcClient(child);
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "happyfox-mcp");
    rpc.notify("notifications/initialized", {});

    const list = await rpc.request("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "add_private_note",
      "create_ticket",
      "get_contact",
      "get_helpdesk_setup",
      "get_ticket",
      "list_contact_groups",
      "list_custom_fields",
      "move_ticket",
      "reply_to_ticket",
      "save_contact",
      "search_contacts",
      "search_tickets",
      "update_ticket",
      "update_ticket_tags",
    ]);
    assert.equal(list.result.tools.find((t) => t.name === "search_tickets").annotations.readOnlyHint, true);
    assert.equal(list.result.tools.find((t) => t.name === "reply_to_ticket").annotations.readOnlyHint, false);

    const setup = await rpc.request("tools/call", { name: "get_helpdesk_setup", arguments: {} });
    const s = JSON.parse(setup.result.content[0].text);
    assert.equal(s.staff[0].id, 7);
    assert.equal(s.statuses[1].name, "Completed");

    const triage = await rpc.request("tools/call", {
      name: "search_tickets",
      arguments: { open_only: true, priorities: ["High"], created_after: "2026-10-01" },
    });
    const t = JSON.parse(triage.result.content[0].text);
    assert.equal(t.tickets.length, 2);
    assert.deepEqual(t.summary.byAssignee, { unassigned: 1, Dana: 1 });
    assert.equal(t.summary.unresponded, 1);
    const q = new URL(seen.find((r) => r.url.startsWith(`${P}/tickets/`)).url, "http://x").searchParams;
    assert.equal(q.get("status"), "_pending");
    assert.equal(q.get("q"), 'priority:"High" created-on-or-after:"2026/10/01"');

    const reply = await rpc.request("tools/call", {
      name: "reply_to_ticket",
      arguments: { ticket: "#SUP00000011", text: "Fixed, please try again.", status_id: 4 },
    });
    assert.equal(JSON.parse(reply.result.content[0].text).status, "Completed");
    const body = JSON.parse(seen.find((r) => r.method === "POST").body);
    assert.deepEqual(body, { staff: 7, plaintext: "Fixed, please try again.", update_customer: true, status: 4 });

    const auth = `Basic ${Buffer.from("key_test:code_test").toString("base64")}`;
    assert.ok(seen.every((r) => r.headers.authorization === auth));

    const bad = await rpc.request("tools/call", { name: "get_ticket", arguments: { ticket: 404 } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /HappyFox API 404/);
  } finally {
    child.kill();
    srv.close();
  }
});
