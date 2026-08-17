/**
 * Programmatic smoke test for the MCP server tools.
 *
 * Uses the MCP SDK's in-process client/server pair (Client + InMemoryTransport)
 * to call each tool without needing stdio or the inspector UI.
 *
 * Run: npx tsx scripts/test-mcp.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { HydraClient } from "../src/hydra/client.js";
import { NODE_LABELS } from "../src/graph/schema.js";
import { runAskPipeline } from "../src/graph/askPipeline.js";
import { extractRepo } from "../src/extract/tsExtractor.js";
import { writeExtractedFiles } from "../src/graph/writer.js";

/* ---- Build the same server that startMcpServer() uses ------------- */
const { version } = (await import("../package.json", {
  with: { type: "json" },
})).default as { version: string };

let client_: HydraClient | undefined;
let configError: string | undefined;
try {
  const config = loadConfig();
  client_ = new HydraClient(config);
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
}

const server = new McpServer({ name: "hydracode-test", version });

function configErrorContent() {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: "config", message: configError }) }],
  };
}

server.tool("hydracode_status", {}, async () => {
  if (!client_) return configErrorContent();
  const [fr, fnr, cr, tr] = await Promise.all([
    client_!.query(`MATCH (n:${NODE_LABELS.FILE}) RETURN count(*) AS total`, undefined, { consistency: "strong" }),
    client_!.query(`MATCH (n:${NODE_LABELS.FUNCTION}) RETURN count(*) AS total`, undefined, { consistency: "strong" }),
    client_!.query(`MATCH (n:${NODE_LABELS.CLASS}) RETURN count(*) AS total`, undefined, { consistency: "strong" }),
    client_!.query(`MATCH (n:${NODE_LABELS.TEST}) RETURN count(*) AS total`, undefined, { consistency: "strong" }),
  ]);
  const ec = (r: { rows: unknown[] }) => {
    const row = r.rows[0];
    if (Array.isArray(row)) return typeof row[0] === "number" ? row[0] : 0;
    if (row && typeof row === "object") { const v = (row as Record<string, unknown>).total; return typeof v === "number" ? v : 0; }
    return 0;
  };
  const counts = { files: ec(fr), functions: ec(fnr), classes: ec(cr), tests: ec(tr) };
  return { content: [{ type: "text" as const, text: JSON.stringify({ indexed: counts.functions > 0, counts }) }] };
});

server.tool("hydracode_ask", { question: z.string(), maxHops: z.number().int().min(1).max(3).default(3).optional() }, async ({ question, maxHops }) => {
  if (!client_) return configErrorContent();
  const result = await runAskPipeline(client_!, question, maxHops ?? 3);
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
});

/* ---- Wire up in-process transport --------------------------------- */
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
await server.connect(serverTransport);
await mcpClient.connect(clientTransport);

/* ---- Test 1: list tools ------------------------------------------- */
console.log("\n=== Test 1: list tools ===");
const toolsResult = await mcpClient.listTools();
console.log("Tools:", toolsResult.tools.map((t: { name: string }) => t.name).join(", "));

/* ---- Test 2: hydracode_status ------------------------------------- */
console.log("\n=== Test 2: hydracode_status ===");
const statusResult = await mcpClient.callTool({ name: "hydracode_status", arguments: {} });
console.log("Raw response:", JSON.stringify(statusResult, null, 2));
const statusContent = (statusResult.content as Array<{ type: string; text: string }>)[0]?.text;
const statusJson = JSON.parse(statusContent ?? "{}");
console.log("Parsed:", JSON.stringify(statusJson, null, 2));
console.assert(typeof statusJson.indexed === "boolean", "indexed must be boolean");
console.assert(typeof statusJson.counts === "object", "counts must be object");
console.log("✓ hydracode_status shape is correct");

/* ---- Test 3: hydracode_ask ---------------------------------------- */
console.log("\n=== Test 3: hydracode_ask ===");
const askResult = await mcpClient.callTool({
  name: "hydracode_ask",
  arguments: { question: "who calls hashToVertexId", maxHops: 3 },
});
console.log("Raw response:", JSON.stringify(askResult, null, 2));
const askContent = (askResult.content as Array<{ type: string; text: string }>)[0]?.text;
const askJson = JSON.parse(askContent ?? "{}");
console.log("Parsed:", JSON.stringify(askJson, null, 2));
console.assert(typeof askJson.resolved === "boolean", "resolved must be boolean");
console.log(`✓ hydracode_ask resolved=${askJson.resolved}, message="${askJson.message}"`);

/* ---- Tear down ---------------------------------------------------- */
await mcpClient.close();
console.log("\n✓ All MCP smoke tests passed.");
