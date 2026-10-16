#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ComputePassClient } from "./api.js";
import { loadConfig } from "./config.js";
import { Ledger } from "./ledger.js";
import { computePassTools, runTool } from "./tools.js";

/**
 * ComputePass MCP server.
 *
 *   stdio (default):  npx tsx src/mcp.ts
 *   HTTP:             MCP_HTTP_TOKEN=... npx tsx src/mcp.ts --http 8787
 *
 * The buyer key stays in this process; the model only sees tool results.
 * HTTP mode is single-tenant (one buyer wallet per server) and requires a
 * bearer token.
 */

const cfg = loadConfig();
const ledger = new Ledger(cfg);
const api = new ComputePassClient(cfg, ledger);

const tools = computePassTools(cfg, ledger, api);

function buildServer() {
  const server = new McpServer({ name: "computepass", version: "0.2.0" });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape, annotations: { readOnlyHint: t.readOnly, openWorldHint: !t.readOnly } },
      async (args: unknown) => {
        const r = await runTool(t, args);
        return { isError: !r.ok, content: [{ type: "text" as const, text: r.text }] };
      },
    );
  }
  return server;
}

async function main() {
  const httpFlag = process.argv.indexOf("--http");
  if (httpFlag === -1) {
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.argv[httpFlag + 1] ?? 8787);
  const token = process.env.MCP_HTTP_TOKEN;
  if (!token) throw new Error("MCP_HTTP_TOKEN is required in --http mode");
  createServer(async (req, res) => {
    if (req.url !== "/mcp") return void res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
    // Stateless: one server + transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, () => console.error(`computepass MCP on http://localhost:${port}/mcp`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
