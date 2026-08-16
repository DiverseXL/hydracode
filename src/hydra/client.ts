import type { HydraCodeConfig } from "../config.js";
import { HydraConnectionError, HydraQueryError } from "./errors.js";

export type HydraConsistency = "causal" | "strong";

export interface HydraQueryResult {
  /** Raw rows extracted defensively from the response body. */
  rows: unknown[];
  /** The full, unmodified response body. */
  raw: unknown;
}

export interface HydraQueryOptions {
  consistency?: HydraConsistency;
}

const QUERY_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;

export class HydraClient {
  private readonly config: HydraCodeConfig;

  constructor(config: HydraCodeConfig) {
    this.config = config;
  }

  /**
   * Run an OpenCypher query against the configured graph.
   *
   * Sends:
   *   POST {httpUri}/v1/graphs/{graph}/query
   *   Authorization: Bearer {token}
   *   X-Graph-Namespace: {namespace}
   *   Content-Type: application/json
   *   { "cell_id": ..., "query": ..., "consistency": "causal" | "strong" }
   *
   * Throws HydraQueryError on non-2xx responses and HydraConnectionError on
   * network failures, so callers can give different guidance for each.
   */
  async query(
    cypher: string,
    params?: Record<string, unknown>,
    opts?: HydraQueryOptions,
  ): Promise<HydraQueryResult> {
    const url = `${this.baseUri()}/v1/graphs/${encodeURIComponent(this.config.graph)}/query`;

    const body = {
      cell_id: this.config.cellId,
      query: inlineParams(cypher, params),
      consistency: opts?.consistency ?? "causal",
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "X-Graph-Namespace": this.config.namespace,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });
    } catch (err) {
      throw new HydraConnectionError(
        `Failed to reach HydraDB at ${this.config.httpUri} — is graph-node running? See the README for local setup.`,
        { cause: err },
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new HydraQueryError(res.status, text);
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new HydraQueryError(
        res.status,
        text,
        `HydraDB returned invalid JSON (HTTP status ${res.status}).`,
      );
    }

    return { rows: extractRows(data), raw: data };
  }

  /**
   * Hit GET /healthz on the configured host (same host/port as the query API
   * for local dev — no port is hardcoded, so a custom port in config works).
   * Returns false on non-2xx; throws HydraConnectionError on network failure.
   */
  async healthCheck(): Promise<boolean> {
    const url = `${this.baseUri()}/healthz`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    } catch (err) {
      throw new HydraConnectionError(
        `Failed to reach HydraDB health endpoint at ${url} — is graph-node running? See the README for local setup.`,
        { cause: err },
      );
    }
    return res.ok;
  }

  /**
   * Best-effort unwrap of a single result cell. HydraDB wraps typed values
   * like {"type": "vertex_id", "value": 2}; we haven't seen every result
   * shape yet, so anything that doesn't match the wrapper is returned as-is.
   */
  unwrapValue(cell: unknown): unknown {
    return unwrapValue(cell);
  }

  private baseUri(): string {
    return this.config.httpUri.replace(/\/+$/, "");
  }
}

/**
 * Inline query parameters as escaped OpenCypher literals.
 *
 * NOTE: HydraDB's OpenCypher subset does not document parameter binding
 * (e.g. `$param`) in the project README, so we cannot assume it is
 * supported. To stay safe, queries reference params as `$name` and this
 * helper substitutes the *escaped literal value* directly into the query
 * string, using the shared escapeCypherScalar escaper (also used by
 * graph/writer.ts to build literal Cypher without native binding).
 *
 * TODO: switch to native parameter binding once confirmed against a running
 * HydraDB instance.
 */
function inlineParams(
  cypher: string,
  params?: Record<string, unknown>,
): string {
  if (!params || Object.keys(params).length === 0) return cypher;

  return cypher.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(
        `Query references parameter $${name} but no value was provided.`,
      );
    }
    return escapeCypherScalar(params[name]);
  });
}

/**
 * Escape a single scalar value as an OpenCypher literal, for safe inlining
 * into a query string. Exported so graph/writer.ts can build literal Cypher
 * from node/edge properties without native parameter binding.
 *
 * Rejects exactly what it always has: objects (only flat scalars and arrays
 * of those are supported), non-finite numbers, and undefined/symbol/function
 * values — callers must not pass those.
 */
export function escapeCypherScalar(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return escapeString(value);
    case "number":
      if (Number.isFinite(value)) return String(value);
      throw new Error(
        `Cannot inline non-finite number (${value}) into a query.`,
      );
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((item) => escapeCypherScalar(item)).join(", ")}]`;
      }
      throw new Error(
        "Cannot inline object parameters into a query; only strings, numbers, booleans, null, and arrays of those are supported.",
      );
    default:
      throw new Error(
        `Cannot inline parameter of type "${typeof value}" into a query.`,
      );
  }
}

/** Single-quoted OpenCypher string literal with all special chars escaped. */
function escapeString(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f]/g, (ch) =>
      `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )}'`;
}

/** Best-effort unwrap of result cells; see HydraClient.unwrapValue. */
export function unwrapValue(cell: unknown): unknown {
  if (Array.isArray(cell)) {
    return cell.map((item) => unwrapValue(item));
  }
  if (cell !== null && typeof cell === "object") {
    const record = cell as Record<string, unknown>;
    if (typeof record.type === "string" && "value" in record) {
      return record.value;
    }
  }
  return cell;
}

/**
 * Defensively extract rows from an unknown response body. We don't yet know
 * the exact top-level shape HydraDB returns, so accept a bare array or a
 * wrapper object with a rows/data/results array; otherwise return [] and
 * leave the raw body available on HydraQueryResult.raw.
 */
function extractRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.rows)) return record.rows;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.results)) return record.results;
  }
  return [];
}
