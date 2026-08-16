/**
 * Typed errors for the HydraDB client, so the CLI can distinguish between
 * "the server answered with an error" and "we couldn't reach the server"
 * and print useful guidance for each.
 */

/** The HydraDB server responded with a non-2xx status. */
export class HydraQueryError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    const summary =
      body.length > 300 ? `${body.slice(0, 300)}…` : body;
    super(message ?? `HydraDB query failed with HTTP status ${status}: ${summary}`);
    this.name = "HydraQueryError";
    this.status = status;
    this.body = body;
  }
}

/** We could not reach the HydraDB server (network failure, refused, timeout). */
export class HydraConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HydraConnectionError";
  }
}
