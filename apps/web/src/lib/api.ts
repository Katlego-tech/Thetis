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
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode | "NETWORK"; status: number };
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
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!baseUrl) throw new Error("NEXT_PUBLIC_API_URL is not set");

  const json = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: json,
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
        return { ok: false, code: error.code, status: response.status };
      }
    }
  }
  return { ok: false, code: "INTERNAL", status: response.status };
}
