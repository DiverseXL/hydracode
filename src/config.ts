import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ENV_PREFIX = "HYDRACODE_HYDRADB";
const CONFIG_FILE = join(process.cwd(), ".hydracode", "config.json");

export const HydraCodeConfigSchema = z
  .object({
    httpUri: z
      .string({
        required_error:
          "httpUri is required — set HYDRACODE_HYDRADB_URI or .hydracode/config.json.",
      })
      .url(
        "httpUri must be a valid URL, e.g. http://127.0.0.1:8443 or https://your-hydradb.example.com:8443.",
      ),
    allowPlaintext: z
      .boolean({
        invalid_type_error: "allowPlaintext must be a boolean (true or false).",
      })
      .default(true),
    token: z
      .string({
        required_error:
          "Missing HydraDB token — set HYDRACODE_HYDRADB_TOKEN or run `hydracode init` (the token is never defaulted).",
      })
      .min(
        1,
        "Missing HydraDB token — set HYDRACODE_HYDRADB_TOKEN or run `hydracode init` (the token is never defaulted).",
      ),
    namespace: z.string().default("default"),
    graph: z.string().default("default"),
    cellId: z.string().default("cell-0"),
  })
  .superRefine((c, ctx) => {
    const scheme = /^https?:\/\//i.test(c.httpUri);
    if (!scheme) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["httpUri"],
        message: "httpUri must start with http:// or https://.",
      });
      return;
    }
    if (!c.allowPlaintext && !c.httpUri.startsWith("https://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["httpUri"],
        message: `httpUri MUST use https:// when allowPlaintext is false (got "${c.httpUri}") — refusing to send a token over plaintext HTTP. For local development, set allowPlaintext to true or use an https:// URI.`,
      });
    }
    if (c.allowPlaintext && !c.httpUri.startsWith("http://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["httpUri"],
        message: `httpUri must use http:// when allowPlaintext is true (got "${c.httpUri}"). If you meant to use https://, set allowPlaintext to false.`,
      });
    }
  });

export type HydraCodeConfig = z.infer<typeof HydraCodeConfigSchema>;

/**
 * Load the effective HydraCode config.
 *
 * Resolution order (highest priority first):
 *   1. HYDRACODE_HYDRADB_* environment variables
 *   2. .hydracode/config.json (project-level, gitignored)
 *   3. Local-dev defaults for httpUri/namespace/graph/cellId (never token)
 *
 * Fails loudly on invalid/missing token or a scheme/plaintext mismatch.
 */
export function loadConfig(): HydraCodeConfig {
  const merged: Record<string, unknown> = {
    ...readFileConfig(),
    ...readEnvConfig(),
  };

  const parsed = HydraCodeConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) =>
        `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(
      [
        "Invalid HydraCode config:",
        ...issues,
        "",
        "Resolve by setting HYDRACODE_HYDRADB_* environment variables, editing .hydracode/config.json, or running `hydracode init`.",
      ].join("\n"),
    );
  }
  return parsed.data;
}

function readEnvConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const get = (name: string): string | undefined => {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
  };

  const uri = get(`${ENV_PREFIX}_URI`);
  if (uri !== undefined) out.httpUri = uri;

  const token = get(`${ENV_PREFIX}_TOKEN`);
  if (token !== undefined) out.token = token;

  const allowPlaintext = get(`${ENV_PREFIX}_ALLOW_PLAINTEXT`);
  if (allowPlaintext !== undefined) {
    const normalized = allowPlaintext.trim().toLowerCase();
    if (normalized === "true") {
      out.allowPlaintext = true;
    } else if (normalized === "false") {
      out.allowPlaintext = false;
    } else {
      throw new Error(
        `${ENV_PREFIX}_ALLOW_PLAINTEXT must be "true" or "false" (got "${allowPlaintext}").`,
      );
    }
  }

  const namespace = get(`${ENV_PREFIX}_NAMESPACE`);
  if (namespace !== undefined) out.namespace = namespace;

  const graph = get(`${ENV_PREFIX}_GRAPH`);
  if (graph !== undefined) out.graph = graph;

  const cellId = get(`${ENV_PREFIX}_CELL_ID`);
  if (cellId !== undefined) out.cellId = cellId;

  return out;
}

function readFileConfig(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(CONFIG_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${CONFIG_FILE}: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
