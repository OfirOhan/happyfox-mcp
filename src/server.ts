import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HappyFoxClient,
  buildTicketQuery,
  compactContact,
  compactTicket,
  conversation,
  summarizeTickets,
  ticketNumber,
  type Record_,
} from "./client.js";

export const VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const ticket = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe("Ticket number (e.g. 42) or display ID (e.g. #DC00000042)");
const staffId = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("ID of the agent making the change. Defaults to HAPPYFOX_STAFF_ID. Find IDs with get_helpdesk_setup");
const tagList = z.array(z.string()).optional();

export interface ServerOptions {
  defaultStaffId?: number;
}

export function createServer(client: HappyFoxClient, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "happyfox-mcp", version: VERSION });

  const staffOf = (v?: number) => {
    const s = v ?? opts.defaultStaffId;
    if (!s) throw new Error("staff_id is required (or set HAPPYFOX_STAFF_ID). Use get_helpdesk_setup to find agent IDs.");
    return s;
  };

  server.registerTool(
    "get_helpdesk_setup",
    {
      title: "Categories, statuses, priorities and agents",
      description:
        "List the help desk's categories, ticket statuses, priorities and agents (staff) with their IDs. Call this first: other tools take these IDs and names.",
      inputSchema: {},
      annotations: RO,
    },
    async () =>
      run(async () => {
        const [categories, statuses, priorities, staff] = await Promise.all([
          client.categories(),
          client.statuses(),
          client.priorities(),
          client.staff(),
        ]);
        const arr = (x: unknown) => (Array.isArray(x) ? (x as Record_[]) : []);
        return {
          categories: arr(categories).map((c) => ({ id: c.id, name: c.name, public: c.public })),
          statuses: arr(statuses).map((s) => ({ id: s.id, name: s.name, behavior: s.behavior, order: s.order })),
          priorities: arr(priorities).map((p) => ({ id: p.id, name: p.name, order: p.order })),
          staff: arr(staff).map((s) => ({ id: s.id, name: s.name, email: s.email, active: s.active, role: (s.role as Record_ | undefined)?.name })),
        };
      }),
  );

  server.registerTool(
    "list_custom_fields",
    {
      title: "Custom fields",
      description:
        "List ticket and contact custom fields with their IDs, types and dropdown choices. Pass values to create_ticket / update_ticket as custom_fields: { \"<id>\": value }.",
      inputSchema: { kind: z.enum(["ticket", "contact", "both"]).optional().describe("Default both") },
      annotations: RO,
    },
    async ({ kind = "both" }) =>
      run(async () => {
        const shape = (f: Record_) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          required: f.required,
          choices: Array.isArray(f.choices) ? (f.choices as Record_[]).map((c) => ({ id: c.id, text: c.text })) : undefined,
        });
        const out: Record_ = {};
        if (kind !== "contact") out.ticket = ((await client.ticketCustomFields()) ?? []).map(shape);
        if (kind !== "ticket") out.contact = ((await client.contactCustomFields()) ?? []).map(shape);
        return out;
      }),
  );

  server.registerTool(
    "search_tickets",
    {
      title: "Search tickets",
      description:
        "Find tickets by status, priority, category, assignee, contact, tags, SLA breach, due date, dates or free text. Returns compact tickets plus counts by status, priority and assignee for the page.",
      inputSchema: {
        open_only: z.boolean().optional().describe("Only tickets in pending (not closed) statuses. Default false (all statuses)"),
        statuses: z.array(z.string()).optional().describe('Status names, e.g. ["New","On Hold"]'),
        priorities: z.array(z.string()).optional().describe('Priority names, e.g. ["High","Critical"]'),
        category_id: z.number().int().optional(),
        assignee: z
          .string()
          .optional()
          .describe('"none" for unassigned, "any" for assigned, or an agent email/username/first or last name'),
        contact: z.string().optional().describe("Contact name, email or phone"),
        tags: tagList.describe("Tags (case sensitive)"),
        unresponded: z.boolean().optional().describe("true = no agent reply yet"),
        breached: z.boolean().optional().describe("true = breached at least one SLA"),
        due: z.enum(["today", "yesterday", "tomorrow", "overdue", "next 7 days"]).optional(),
        created_after: z.string().optional().describe("ISO date, e.g. 2026-10-01"),
        created_before: z.string().optional().describe("ISO date"),
        modified_after: z.string().optional().describe("ISO date"),
        text: z.string().optional().describe("Free-text search"),
        sort: z
          .string()
          .optional()
          .describe("e.g. created (newest first), createa, updated, due, priorityd, statusa, unresponded"),
        size: z.number().int().min(1).max(50).optional().describe("Results per page, max 50 (default 20)"),
        page: z.number().int().min(1).optional(),
        raw: z.boolean().optional().describe("Return HappyFox's full objects"),
      },
      annotations: RO,
    },
    async ({ open_only, category_id, sort, size = 20, page, raw, ...f }) =>
      run(async () => {
        const res = await client.listTickets({
          status: open_only ? "_pending" : "_all",
          category: category_id,
          q: buildTicketQuery(f),
          sort,
          size,
          page,
        });
        const data = Array.isArray(res?.data) ? res.data : [];
        if (raw) return res;
        return { page_info: res?.page_info, summary: summarizeTickets(data), tickets: data.map(compactTicket) };
      }),
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get ticket with conversation",
      description:
        "Get one ticket: properties, contact, custom fields and the full conversation (replies, private notes and status/priority/assignee changes) in order.",
      inputSchema: {
        ticket,
        max_chars_per_message: z.number().int().min(100).optional().describe("Truncate long messages (default 2000)"),
        raw: z.boolean().optional(),
      },
      annotations: RO,
    },
    async ({ ticket: t, max_chars_per_message, raw }) =>
      run(async () => {
        const res = await client.getTicket(ticketNumber(t));
        if (raw) return res;
        const cfs = ((res.custom_fields as Record_[] | undefined) ?? []).filter((f) => f.value !== null && f.value !== "");
        return {
          ...compactTicket(res),
          first_message: res.first_message,
          custom_fields: Object.fromEntries(cfs.map((f) => [String(f.name), f.value])),
          conversation: conversation(res, max_chars_per_message),
        };
      }),
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create ticket",
      description:
        "Create a ticket on behalf of a contact (new or existing, matched by email). Needs a public category ID from get_helpdesk_setup.",
      inputSchema: {
        category_id: z.number().int(),
        subject: z.string().min(1),
        text: z.string().optional().describe("Message in plain text"),
        html: z.string().optional().describe("Message in HTML (instead of text)"),
        name: z.string().optional().describe("Contact name (required for new contacts)"),
        email: z.string().email().optional().describe("Contact email (required for new contacts)"),
        contact_id: z.number().int().optional().describe("Existing contact ID, instead of name/email"),
        phone: z.string().optional(),
        priority_id: z.number().int().optional(),
        assignee_id: z.number().int().optional(),
        tags: tagList,
        cc: z.array(z.string().email()).optional(),
        due_date: z.string().optional().describe("YYYY-MM-DD"),
        staff_only: z.boolean().optional().describe("Private ticket visible only to staff"),
        custom_fields: z.record(z.any()).optional().describe('Ticket custom fields by ID, e.g. {"3": "value"}'),
      },
      annotations: WRITE,
    },
    async (a) =>
      run(async () => {
        if (!a.text && !a.html) throw new Error("Provide text or html.");
        if (!a.contact_id && !a.email) throw new Error("Provide email (and name) for the contact, or contact_id.");
        const body: Record_ = {
          category: a.category_id,
          subject: a.subject,
          text: a.text,
          html: a.html,
          name: a.name,
          email: a.email,
          client: a.contact_id,
          phone: a.phone,
          priority: a.priority_id,
          assignee: a.assignee_id,
          tags: a.tags?.join(","),
          cc: a.cc?.join(","),
          due_date: a.due_date,
          visible_only_staff: a.staff_only,
        };
        for (const [k, v] of Object.entries(a.custom_fields ?? {})) body[`t-cf-${k}`] = v;
        return compactTicket(await client.createTicket(body));
      }),
  );

  const changeFields = {
    status_id: z.number().int().optional().describe("New status ID"),
    priority_id: z.number().int().optional().describe("New priority ID"),
    assignee_id: z.number().int().nullable().optional().describe("New assignee agent ID, or null to unassign"),
    due_date: z.string().optional().describe("YYYY-MM-DD"),
    time_spent: z.number().int().min(0).optional().describe("Minutes to add as time spent"),
    custom_fields: z.record(z.any()).optional().describe('Ticket custom fields by ID, e.g. {"3": "value"}'),
  };
  const changeBody = (a: {
    status_id?: number;
    priority_id?: number;
    assignee_id?: number | null;
    due_date?: string;
    time_spent?: number;
    custom_fields?: Record<string, unknown>;
  }) => {
    const b: Record_ = {
      status: a.status_id,
      priority: a.priority_id,
      assignee: a.assignee_id,
      due_date: a.due_date,
      time_spent: a.time_spent,
    };
    for (const [k, v] of Object.entries(a.custom_fields ?? {})) b[`t-cf-${k}`] = v;
    return b;
  };

  server.registerTool(
    "reply_to_ticket",
    {
      title: "Reply to customer",
      description:
        "Post an agent reply on a ticket. By default the contact is emailed (notify_customer: true). Can change status, priority or assignee in the same update, e.g. reply and set status to Completed.",
      inputSchema: {
        ticket,
        text: z.string().optional().describe("Reply in plain text"),
        html: z.string().optional().describe("Reply in HTML (instead of text)"),
        notify_customer: z.boolean().optional().describe("Email the reply to the contact. Default true"),
        cc: z.array(z.string().email()).optional(),
        staff_id: staffId,
        ...changeFields,
      },
      annotations: WRITE,
    },
    async ({ ticket: t, text, html, notify_customer = true, cc, staff_id, ...ch }) =>
      run(async () => {
        if (!text && !html) throw new Error("Provide text or html.");
        const res = await client.staffUpdate(ticketNumber(t), {
          staff: staffOf(staff_id),
          plaintext: text,
          html,
          update_customer: notify_customer,
          cc: cc?.join(","),
          ...changeBody(ch),
        });
        return compactTicket(res);
      }),
  );

  server.registerTool(
    "add_private_note",
    {
      title: "Add private note",
      description: "Add an internal note visible only to agents. Never emailed to the customer. Can alert subscribers or the category's agents.",
      inputSchema: {
        ticket,
        text: z.string().min(1),
        alert: z
          .union([z.enum(["subscribers", "category"]), z.number().int()])
          .optional()
          .describe('"subscribers", "category" (all agents in the category) or one agent ID'),
        staff_id: staffId,
        ...changeFields,
      },
      annotations: WRITE,
    },
    async ({ ticket: t, text, alert, staff_id, ...ch }) =>
      run(async () => {
        const a = alert === "subscribers" ? "s" : alert === "category" ? "c" : alert;
        const res = await client.privateNote(ticketNumber(t), { staff: staffOf(staff_id), plaintext: text, alert: a, ...changeBody(ch) });
        return compactTicket(res);
      }),
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update ticket properties",
      description:
        "Change a ticket's status, priority, assignee, due date, time spent or custom fields without sending a message. Use IDs from get_helpdesk_setup.",
      inputSchema: { ticket, staff_id: staffId, ...changeFields },
      annotations: UPDATE,
    },
    async ({ ticket: t, staff_id, ...ch }) =>
      run(async () => {
        const body = changeBody(ch);
        if (Object.values(body).every((v) => v === undefined)) throw new Error("Nothing to update.");
        return compactTicket(await client.staffUpdate(ticketNumber(t), { staff: staffOf(staff_id), ...body }));
      }),
  );

  server.registerTool(
    "update_ticket_tags",
    {
      title: "Add or remove tags",
      description: "Add and/or remove tags on a ticket.",
      inputSchema: { ticket, add: tagList, remove: tagList, staff_id: staffId },
      annotations: UPDATE,
    },
    async ({ ticket: t, add, remove, staff_id }) =>
      run(async () => {
        if (!add?.length && !remove?.length) throw new Error("Provide tags to add or remove.");
        const res = await client.updateTags(ticketNumber(t), { add: add?.join(","), remove: remove?.join(","), staff_id: staffOf(staff_id) });
        return { number: res.id ?? ticketNumber(t), tags: res.tags };
      }),
  );

  server.registerTool(
    "move_ticket",
    {
      title: "Move ticket to another category",
      description: "Move a ticket to a different category (team/queue), optionally with a note and a new assignee.",
      inputSchema: {
        ticket,
        category_id: z.number().int(),
        note: z.string().optional(),
        assign_to: z.number().int().optional().describe("Agent ID"),
        staff_id: staffId,
      },
      annotations: UPDATE,
    },
    async ({ ticket: t, category_id, note, assign_to, staff_id }) =>
      run(() =>
        client.moveTicket(ticketNumber(t), {
          staff_id: staffOf(staff_id),
          target_category_id: category_id,
          move_note: note,
          assign_to,
        }),
      ),
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description: "Find contacts by name, email or phone (all given filters must match). Returns ticket counts and contact groups.",
      inputSchema: {
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional().describe("Digits only, no +"),
        size: z.number().int().min(10).max(50).optional().describe("10-50, default 20"),
        page: z.number().int().min(1).optional(),
      },
      annotations: RO,
    },
    async ({ name, email, phone, size = 20, page }) =>
      run(async () => {
        const q = [name && `name:${name}`, email && `email:${email}`, phone && `phone:${phone.replace(/^\+/, "")}`]
          .filter(Boolean)
          .join(" ");
        const res = await client.listContacts({ q: q || undefined, size, page });
        const data = Array.isArray(res?.data) ? res.data : [];
        return { page_info: res?.page_info, contacts: data.map(compactContact) };
      }),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Get contact",
      description: "Get one contact by ID or email, with phones, groups, custom fields and ticket counts.",
      inputSchema: { contact: z.union([z.number().int(), z.string()]).describe("Contact ID or email address") },
      annotations: RO,
    },
    async ({ contact }) => run(async () => compactContact(await client.getContact(contact))),
  );

  server.registerTool(
    "save_contact",
    {
      title: "Create or update contact",
      description:
        "Create a contact, or update one when contact_id is given. Custom fields are set by ID (see list_custom_fields).",
      inputSchema: {
        contact_id: z.number().int().optional().describe("Existing contact to update"),
        name: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional().describe("Primary mobile number"),
        custom_fields: z.record(z.any()).optional().describe('Contact custom fields by ID, e.g. {"4": "ACME-001"}'),
      },
      annotations: UPDATE,
    },
    async ({ contact_id, name, email, phone, custom_fields }) =>
      run(async () => {
        const body: Record_ = {
          name,
          email,
          phones: phone ? [{ type: "mo", number: phone, is_primary: true }] : undefined,
        };
        for (const [k, v] of Object.entries(custom_fields ?? {})) body[`c-cf-${k}`] = v;
        if (contact_id) return compactContact(await client.updateContact(contact_id, body));
        if (!name || !email) throw new Error("name and email are required for a new contact.");
        return compactContact(await client.createContact(body));
      }),
  );

  server.registerTool(
    "list_contact_groups",
    {
      title: "Contact groups",
      description: "List contact groups (customer organizations) with their tagged email domains.",
      inputSchema: {},
      annotations: RO,
    },
    async () => run(() => client.contactGroups()),
  );

  return server;
}
