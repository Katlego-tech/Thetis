export function loginHref(next: string, expired: boolean): string {
  const href = `/login?next=${encodeURIComponent(next)}`;
  return expired ? `${href}&reason=expired` : href;
}

export function isExpiredResponse(r: {
  status?: number;
  error?: { code?: string } | null;
}): boolean {
  return r.status === 401 || r.error?.code === "PGRST301" || r.error?.code === "PGRST303";
}
