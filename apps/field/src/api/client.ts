// The Thetis API over fetch: bearer token, a timeout per route, and the {data} / {error} envelope.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: string | null,
  ) {
    super(`${code}: ${message}`);
    this.name = "ApiError";
  }
}

/** The request did not answer within its limit. Nothing is known about whether it landed. */
export class ApiTimeout extends Error {
  constructor() {
    super("timeout");
    this.name = "ApiTimeout";
  }
}

/** The network failed before an answer arrived. */
export class ApiUnreachable extends Error {
  constructor(cause?: unknown) {
    super("unreachable", { cause });
    this.name = "ApiUnreachable";
  }
}

/** A 2xx body that is not the shape the route promises. */
export class ApiShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiShapeError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface ApiClient {
  request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; timeoutMs: number; parse: (data: unknown) => T },
  ): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseError(status: number, body: unknown): ApiError {
  const error = isRecord(body) ? body.error : undefined;
  if (isRecord(error) && typeof error.code === "string") {
    const detail = typeof error.detail === "string" ? error.detail : null;
    const message = typeof error.message === "string" ? error.message : "";
    return new ApiError(status, error.code, message, detail);
  }
  return new ApiError(status, status >= 500 ? "INTERNAL" : "UNEXPECTED", "", null);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async request(method, path, { body, timeoutMs, parse }) {
      const token = await options.getToken();
      if (!token) throw new ApiError(401, "NOT_AUTHENTICATED", "", null);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      let response: Response;
      let parsed: unknown;
      try {
        response = await doFetch(`${options.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        parsed = await response.json().catch(() => undefined);
      } catch (cause) {
        if (timedOut) throw new ApiTimeout();
        throw new ApiUnreachable(cause);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw parseError(response.status, parsed);
      if (!isRecord(parsed) || !("data" in parsed) || Object.keys(parsed).length !== 1) {
        throw new ApiShapeError("The answer is not a {data} envelope.");
      }
      try {
        return parse(parsed.data);
      } catch (error) {
        // A body the route's parser refuses is the relay answering wrongly, not the network.
        throw new ApiShapeError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Route timeouts on the phone, in milliseconds. */
export const TIMEOUTS = {
  create: 15_000,
  renew: 15_000,
  signatures: 30_000,
  get: 30_000,
  walletLink: 8_000,
  finalize: 8_000,
} as const;
