#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HappyFoxClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  const apiKey = process.env.HAPPYFOX_API_KEY ?? "";
  const authCode = process.env.HAPPYFOX_AUTH_CODE ?? "";
  const domain = process.env.HAPPYFOX_DOMAIN ?? "";
  const baseUrl = process.env.HAPPYFOX_BASE_URL || undefined;
  if (!apiKey || !authCode || (!domain && !baseUrl)) {
    console.error(
      "happyfox-mcp: set HAPPYFOX_API_KEY, HAPPYFOX_AUTH_CODE and HAPPYFOX_DOMAIN (e.g. acme.happyfox.com). Create the key in HappyFox under Apps > Goodies > API.",
    );
    process.exit(1);
  }
  const staff = Number(process.env.HAPPYFOX_STAFF_ID ?? "");
  const client = new HappyFoxClient({ apiKey, authCode, domain, baseUrl });
  const server = createServer(client, { defaultStaffId: Number.isFinite(staff) && staff > 0 ? staff : undefined });
  await server.connect(new StdioServerTransport());
  console.error(`happyfox-mcp running (${client.baseUrl})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
