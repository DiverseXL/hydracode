/**
 * SARIF 2.1.0 parser — extracts security findings from a SARIF JSON blob.
 *
 * SARIF (Static Analysis Results Interchange Format) is a well-documented
 * JSON format (schema at docs.oasis-open.org/sarif/sarif/v2.1.0). No npm
 * dependency needed — we parse it directly from the parsed JSON object.
 *
 * Normalization:
 * - uri: strip leading "./" or repo-root prefix, normalize to forward slashes
 * - startLine/endLine: SARIF lines are 1-indexed, keep as-is
 * - Skip results with no physicalLocation (some tools emit location-free findings)
 * - Deduplicate by (ruleId + uri + startLine)
 */

import path from "node:path";
import type { SecurityFindingNode } from "../graph/schema.js";

/** A parsed finding ready for writing to the graph. */
export interface ParsedFinding {
  ruleId: string;
  message: string;
  severity: SecurityFindingNode["severity"];
  /** Repo-relative file path, normalized to forward slashes. */
  uri: string;
  startLine: number;
  endLine: number;
  tool: string;
}

/**
 * SARIF 2.1.0 top-level structure (partial — only the fields we read).
 * Defined inline so we don't need a schema package.
 */
interface SarifRun {
  tool?: { driver?: { name?: string } };
  results?: SarifResult[];
}

interface SarifResult {
  ruleId?: string;
  message?: { text?: string };
  level?: string;
  locations?: SarifLocation[];
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number; endLine?: number };
  };
}

interface SarifRoot {
  version?: string;
  runs?: SarifRun[];
}

/**
 * Parse a SARIF JSON object into an array of ParsedFindings.
 *
 * @param sarifJson — the parsed JSON root (from JSON.parse)
 * @param repoRoot — absolute path to the repo root, used to strip prefixes from URIs
 * @returns deduplicated array of findings
 */
export function parseSarif(sarifJson: unknown, repoRoot: string): ParsedFinding[] {
  if (sarifJson === null || typeof sarifJson !== "object") {
    return [];
  }

  const sarif = sarifJson as SarifRoot;
  if (!Array.isArray(sarif.runs)) {
    return [];
  }

  const seen = new Set<string>();
  const findings: ParsedFinding[] = [];

  for (const run of sarif.runs) {
    const toolName = run.tool?.driver?.name ?? "unknown";
    if (!Array.isArray(run.results)) continue;

    for (const result of run.results) {
      const ruleId = result.ruleId ?? "unknown";
      const message = result.message?.text ?? "";
      const severity = normalizeSeverity(result.level);

      // Some SARIF tools emit location-free findings — skip them.
      const loc = result.locations?.[0]?.physicalLocation;
      if (loc === undefined) continue;

      const rawUri = loc.artifactLocation?.uri;
      if (rawUri === undefined || rawUri.length === 0) continue;

      const uri = normalizeUri(rawUri, repoRoot);
      const startLine = loc.region?.startLine ?? 1;
      const endLine = loc.region?.endLine ?? startLine;

      // Deduplicate by (ruleId + uri + startLine).
      const dedupKey = `${ruleId}:${uri}:${startLine}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      findings.push({
        ruleId,
        message,
        severity,
        uri,
        startLine,
        endLine,
        tool: toolName,
      });
    }
  }

  return findings;
}

/** Normalize SARIF severity levels to our enum. */
function normalizeSeverity(level: string | undefined): SecurityFindingNode["severity"] {
  switch (level) {
    case "error":
    case "warning":
    case "note":
    case "none":
      return level;
    default:
      return "warning";
  }
}

/**
 * Normalize a SARIF artifact URI to a repo-relative forward-slash path.
 *
 * Strips leading "./" or repo-root prefix, converts backslashes to forward
 * slashes. Same normalization as the extractor uses for File.path.
 */
function normalizeUri(uri: string, repoRoot: string): string {
  let normalized = uri.replace(/\\/g, "/");

  // Strip leading "./"
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  // Strip repo root prefix (absolute URIs)
  const rootForward = repoRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith(rootForward + "/")) {
    normalized = normalized.slice(rootForward.length + 1);
  } else if (normalized.startsWith(rootForward)) {
    normalized = normalized.slice(rootForward.length);
  }

  // Strip leading "/" (absolute paths)
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }

  return normalized;
}
