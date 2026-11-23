const fallback = "/account";

export function safeNext(next: string | null): string {
  if (!next?.startsWith("/") || next[1] === "/" || next[1] === "\\" || /\s/.test(next)) {
    return fallback;
  }

  for (const character of next) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return fallback;
  }

  const path = next.split(/[?#]/, 1)[0] ?? "";
  if (path.includes("%") || path.includes("//")) return fallback;

  const { pathname } = new URL(next, "https://thetis.invalid");
  return pathname === "/login" || pathname === "/login/" ? fallback : next;
}
