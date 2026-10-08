# HappyFox Help Desk MCP Server

[![CI](https://github.com/OfirOhan/happyfox-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OfirOhan/happyfox-mcp/actions/workflows/ci.yml)
![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[HappyFox Help Desk](https://www.happyfox.com)**. It lets Claude, Cursor, ChatGPT and other AI agents triage the ticket queue, read full conversations, reply to customers, leave private notes, change status, priority and assignee, and look up contacts.

> **Unofficial.** This is a community project and is not affiliated with HappyFox. It was built from HappyFox's public API documentation.

## What you can ask your agent

- "What's on fire? Open High and Critical tickets with no reply yet, grouped by assignee."
- "Summarize ticket #SUP00000123 and draft a reply. Don't send it until I say so."
- "Reply to 123 saying the fix is live, and set it to Completed."
- "Add a private note on 123 for the billing team and move it to the Billing category."
- "Which tickets breached SLA this week? Which ones are overdue?"
- "Who is jo@example.com, which group are they in, and how many tickets are still pending?"

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `get_helpdesk_setup` | Categories, statuses, priorities and agents with IDs | No |
| `list_custom_fields` | Ticket and contact custom fields with IDs and choices | No |
| `search_tickets` | Tickets by status, priority, category, assignee, contact, tags, SLA breach, due date, dates or text. **Returns counts by status, priority and assignee** | No |
| `get_ticket` | One ticket with its whole conversation, notes and status changes in order | No |
| `create_ticket` | Create a ticket for a new or existing contact | Yes |
| `reply_to_ticket` | Agent reply (emails the customer by default), optionally changing status/priority/assignee | Yes |
| `add_private_note` | Internal note, never emailed, with optional alerts | Yes |
| `update_ticket` | Change status, priority, assignee, due date, time spent or custom fields | Yes |
| `update_ticket_tags` | Add or remove tags | Yes |
| `move_ticket` | Move to another category, with a note and new assignee | Yes |
| `search_contacts` | Contacts by name, email or phone | No |
| `get_contact` | One contact by ID or email | No |
| `save_contact` | Create or update a contact | Yes |
| `list_contact_groups` | Contact groups (customer organizations) | No |

The server handles the parts an LLM tends to get wrong: it builds HappyFox's search syntax (`status:"New","On Hold" created-on-or-after:"2026/10/01"`), accepts either ticket numbers or display IDs like `#SUP00000011`, maps custom field IDs to the `t-cf-<id>` / `c-cf-<id>` payload keys, and returns compact tickets and readable conversations instead of full API payloads (use `raw: true` for everything). Write tools carry MCP annotations, so clients can ask before running them.

## Setup

1. In HappyFox, go to **Apps > Goodies > API**, enable it, and create an API key and auth code.
2. Note the agent ID that changes should be made as (from `get_helpdesk_setup`, or the staff list).
3. Build it:

```bash
git clone https://github.com/OfirOhan/happyfox-mcp.git
cd happyfox-mcp && npm install && npm run build
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "happyfox": {
      "command": "node",
      "args": ["/absolute/path/to/happyfox-mcp/dist/index.js"],
      "env": {
        "HAPPYFOX_DOMAIN": "acme.happyfox.com",
        "HAPPYFOX_API_KEY": "...",
        "HAPPYFOX_AUTH_CODE": "...",
        "HAPPYFOX_STAFF_ID": "1"
      }
    }
  }
}
```

### Claude Code / Cursor / other MCP clients

```bash
claude mcp add happyfox -e HAPPYFOX_DOMAIN=acme.happyfox.com -e HAPPYFOX_API_KEY=... -e HAPPYFOX_AUTH_CODE=... -e HAPPYFOX_STAFF_ID=1 -- node /path/to/happyfox-mcp/dist/index.js
```

For Cursor and other clients, use the same command with the variables in the environment.

| Variable | Default | Notes |
|---|---|---|
| `HAPPYFOX_DOMAIN` | (required) | `acme`, `acme.happyfox.com`, `acme.happyfox.net` (EU) or your custom domain |
| `HAPPYFOX_API_KEY` | (required) | API key |
| `HAPPYFOX_AUTH_CODE` | (required) | Auth code |
| `HAPPYFOX_STAFF_ID` | (none) | Default agent ID for replies, notes and updates. Tools also accept `staff_id` |
| `HAPPYFOX_BASE_URL` | derived from the domain | Override for testing |

## Development

```bash
npm install
npm test   # builds, runs unit tests and an end-to-end MCP stdio test against a fake HappyFox API
```

The tests run on Node 20, 22 and 24 in CI.

## Author

Built by [Ofir Ohana](https://github.com/OfirOhan), an AI agents engineer. Issues and PRs are welcome.

## License

MIT
