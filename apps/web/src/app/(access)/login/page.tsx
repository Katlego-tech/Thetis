import { LoginForm } from "@/components/access/login-form";
import { safeNext } from "@/lib/safe-next";

type QueryValue = string | string[] | undefined;

function first(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: QueryValue; reason?: QueryValue }>;
}) {
  const { next, reason } = await searchParams;
  return <LoginForm next={safeNext(first(next) ?? null)} expired={first(reason) === "expired"} />;
}
