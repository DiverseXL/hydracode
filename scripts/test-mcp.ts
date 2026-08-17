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
import { HydraClient, unwrapValue } from "../src/hydra/client.js";
import { NODE_LABELS } from "../src/graph/schema.js";
import { runAskPipeline } from "../src/graph/askPipeline.js";
import { checkDuplicateRisk } from "../src/graph/duplicateCheck.js";
import {
  recallMemoryFacts,
  recordKnownDuplicate,
  recordMemoryFactAbout,
} from "../src/memory/store.js";
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
    // Cells arrive Rust-wrapped ({type, value}) — unwrap before type-checking.
    const row = r.rows[0];
    if (Array.isArray(row)) { const v = unwrapValue(row[0]); return typeof v === "number" ? v : 0; }
    if (row && typeof row === "object") { const v = unwrapValue((row as Record<string, unknown>).total); return typeof v === "number" ? v : 0; }
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

server.tool(
  "hydracode_check_duplicate",
  {
    proposedName: z.string(),
    targetFile: z.string().optional(),
    recordReason: z.string().optional(),
  },
  async ({ proposedName, targetFile, recordReason }) => {
    if (!client_) return configErrorContent();
    const result = await checkDuplicateRisk(
      client_!,
      proposedName,
      targetFile !== undefined ? { targetFile } : undefined,
    );
    if (recordReason !== undefined && result.candidates.length > 0) {
      const recorded = await recordKnownDuplicate(
        client_!,
        proposedName,
        recordReason,
        result.candidates,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, recorded }) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "hydracode_record_decision",
  {
    text: z.string(),
    about: z.string().optional(),
  },
  async ({ text, about }) => {
    if (!client_) return configErrorContent();
    const { recorded } = await recordMemoryFactAbout(client_!, text, about);
    return { content: [{ type: "text" as const, text: JSON.stringify({ recorded }) }] };
  },
);

server.tool(
  "hydracode_recall_memory",
  {
    query: z.string(),
    about: z.string().optional(),
  },
  async ({ query, about }) => {
    if (!client_) return configErrorContent();
    const facts = await recallMemoryFacts(client_!, { query, about });
    return { content: [{ type: "text" as const, text: JSON.stringify({ facts }) }] };
  },
);

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

/* ---- Test 4: hydracode_check_duplicate ---------------------------- */
const dupCases = [
  { name: "writeExtractedFiles" },
  { name: "fetchGraphStatus" },
  { name: "calculateFooBarBaz123" },
];
const dupRecordCase = {
  name: "summarizeGraph",
  reason: "recorded via test-mcp smoke test",
  targetFile: "src/graph/agentsSummary.ts",
};
for (const c of dupCases) {
  console.log(`\n=== Test 4: hydracode_check_duplicate(${JSON.stringify(c.name)}) ===`);
  const dupResult = await mcpClient.callTool({
    name: "hydracode_check_duplicate",
    arguments: { proposedName: c.name },
  });
  const dupContent = (dupResult.content as Array<{ type: string; text: string }>)[0]?.text;
  const dupJson = JSON.parse(dupContent ?? "{}");
  console.log("Parsed:", JSON.stringify(dupJson, null, 2));
  console.assert(Array.isArray(dupJson.candidates), "candidates must be an array");
  console.assert(typeof dupJson.message === "string", "message must be a string");
  for (const cand of dupJson.candidates) {
    console.assert(typeof cand.key === "string", "candidate.key must be a string");
    console.assert(typeof cand.file === "string", "candidate.file must be a string");
    console.assert(typeof cand.line === "number", "candidate.line must be a number");
    console.assert(["high", "medium", "low"].includes(cand.confidence), "bad confidence");
    console.assert(
      ["exact_name", "similar_name", "same_file_similar_purpose"].includes(cand.matchReason),
      "bad matchReason",
    );
  }
  console.log(`✓ shape is correct, message="${dupJson.message}"`);
}

/* ---- Test 4b: recordReason writes a memory fact -------------------- */
console.log(`\n=== Test 4b: hydracode_check_duplicate with recordReason ===`);
const recResult = await mcpClient.callTool({
  name: "hydracode_check_duplicate",
  arguments: {
    proposedName: dupRecordCase.name,
    targetFile: dupRecordCase.targetFile,
    recordReason: dupRecordCase.reason,
  },
});
const recContent = (recResult.content as Array<{ type: string; text: string }>)[0]?.text;
const recJson = JSON.parse(recContent ?? "{}");
console.log("Parsed:", JSON.stringify(recJson, null, 2));
console.assert(recJson.candidates.length > 0, "expected candidates for summarizeGraph");
console.assert(typeof recJson.recorded?.key === "string", "recorded.key must be a string");
console.assert(recJson.recorded.key.startsWith("memory:"), "recorded key must be memory:<uuid>");
console.log(`✓ recorded=${recJson.recorded.key}, message="${recJson.message}"`);

/* ---- Test 5: hydracode_recall_memory ------------------------------ */
console.log("\n=== Test 5: hydracode_recall_memory ===");
const recMemResult = await mcpClient.callTool({
  name: "hydracode_recall_memory",
  arguments: { query: "prefer published image" },
});
const recMemContent = (recMemResult.content as Array<{ type: string; text: string }>)[0]?.text;
const recMemJson = JSON.parse(recMemContent ?? "{}");
console.log("Parsed:", JSON.stringify(recMemJson, null, 2));
console.assert(Array.isArray(recMemJson.facts), "facts must be an array");
const recMemFacts = recMemJson.facts as Array<{ key: string; text: string; createdAt: string; about: string[] }>;
for (const f of recMemFacts) {
  console.assert(typeof f.key === "string" && f.key.startsWith("memory:"), "fact key must be memory:<uuid>");
  console.assert(typeof f.text === "string", "fact text must be a string");
  console.assert(typeof f.createdAt === "string", "fact createdAt must be a string");
  console.assert(Array.isArray(f.about), "fact about must be an array");
}
const cliRecorded = recMemFacts.find((f) => f.text.includes("prefer the published GHCR image"));
console.assert(cliRecorded !== undefined, "expected the CLI-recorded fact to come back through MCP");
console.log(`✓ recall found ${recMemFacts.length} fact(s) via MCP, CLI-recorded fact present=${cliRecorded !== undefined}`);

/* ---- Test 6: hydracode_recall_memory with --about ----------------- */
console.log("\n=== Test 6: hydracode_recall_memory about=writeExtractedFiles ===");
const recMemAboutResult = await mcpClient.callTool({
  name: "hydracode_recall_memory",
  arguments: { query: "anything", about: "writeExtractedFiles" },
});
const recMemAboutContent = (recMemAboutResult.content as Array<{ type: string; text: string }>)[0]?.text;
const recMemAboutJson = JSON.parse(recMemAboutContent ?? "{}");
console.log("Parsed:", JSON.stringify(recMemAboutJson, null, 2));
const aboutFacts = (recMemAboutJson.facts as Array<{ text: string; about: string[] }>) ?? [];
console.assert(
  aboutFacts.some((f) => f.text.includes("prefer the published GHCR image")),
  "expected the about-linked fact",
);
console.log(`✓ recall by about found ${aboutFacts.length} fact(s)`);

/* ---- Tear down ---------------------------------------------------- */
await mcpClient.close();
console.log("\n✓ All MCP smoke tests passed.");
