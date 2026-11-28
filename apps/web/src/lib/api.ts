const apiErrorCodes = [
  "VALIDATION",
  "NOT_AUTHENTICATED",
  "NOT_AUTHORISED",
  "NOT_FOUND",
  "INVITATION_EXISTS",
  "CHALLENGE_INVALID",
  "WALLET_ALREADY_LINKED",
  "EVIDENCE_VERSION_INVALID",
  "MEMBERSHIP_INVALID",
  "LINK_INVALID",
  "BAD_SIGNATURE",
  "WALLET_INVALID",
  "INTERNAL",
  // live-lending.md §6.5.2
  "WRONG_SETTLEMENT_MODE",
  "ACCOUNT_MISSING",
  "PAYMENT_ALREADY_RECORDED",
  "PAYMENT_NOT_CONFIRMED",
  "EVIDENCE_INVALID",
  "WALLET_NOT_LINKED",
  "AUTHORITY_INVALID",
  "ALREADY_SIGNED",
  "COMMAND_STATE",
  "STALE_TEXT",
  "TEXT_EXPIRED",
  "BLOCKHASH_EXPIRED",
  "TOKEN_ACCOUNT_MISSING",
  "ROLE_INVALID",
  "TRANSACTION_TOO_LARGE",
  "TRANSACTION_MISMATCH",
  "TOO_MANY_OPEN_COMMANDS",
  "COMMANDS_UNAVAILABLE",
  "CHAIN_UNAVAILABLE",
  "SPONSOR_UNAVAILABLE",
  "LOOKUP_TABLE_FULL",
  // live-lending.md T064b.4 pre-check fold 1: the relay's loading refusals
  "ACCEPTANCE_MISSING",
  "LOAN_NOT_ACTIVE",
  "LOADING_NOT_OPEN",
  "LOADING_EXPIRED",
  "TOO_MANY_LOANS",
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode | "NETWORK"; status: number; detail?: string };
export type WalletChallenge = { challengeId: string; message: string; expiresAt: string };
export type WalletLink = { linkId: string; wallet: string; organisationId: string };

function isApiErrorCode(code: unknown): code is ApiErrorCode {
  return apiErrorCodes.some((knownCode) => code === knownCode);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  accessToken: string,
): Promise<ApiResult<T>> {
  return request<T>(path, accessToken, { method: "POST", body: JSON.stringify(body) });
}

export async function apiGet<T>(
  path: string,
  accessToken: string,
  options: { signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  return request<T>(path, accessToken, { method: "GET", ...options });
}

async function request<T>(
  path: string,
  accessToken: string,
  init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal },
): Promise<ApiResult<T>> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!baseUrl) throw new Error("NEXT_PUBLIC_API_URL is not set");

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch {
    return { ok: false, code: "NETWORK", status: 0 };
  }

  const payload: unknown = await response.json().catch(() => null);
  if (payload && typeof payload === "object") {
    if (response.ok && Object.hasOwn(payload, "data") && "data" in payload) {
      return { ok: true, data: payload.data as T };
    }
    if (!response.ok && "error" in payload) {
      const { error } = payload;
      if (error && typeof error === "object" && "code" in error && isApiErrorCode(error.code)) {
        const detail = "detail" in error && typeof error.detail === "string" ? error.detail : null;
        return detail === null
          ? { ok: false, code: error.code, status: response.status }
          : { ok: false, code: error.code, status: response.status, detail };
      }
    }
  }
  return { ok: false, code: "INTERNAL", status: response.status };
}
