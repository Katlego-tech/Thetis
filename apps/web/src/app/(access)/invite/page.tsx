import type { Metadata } from "next";
import { InviteAccept } from "@/components/access/invite-accept";

export const metadata: Metadata = { title: "Invitation" };

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  const firstToken = Array.isArray(token) ? token[0] : token;
  return <InviteAccept token={firstToken ?? null} />;
}
