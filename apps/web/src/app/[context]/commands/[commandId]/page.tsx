import type { Metadata } from "next";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import { CommandLive } from "@/components/commands/command-live";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { LiveShell } from "@/components/shell/live-shell";
import { COMMAND_KINDS } from "@/data/live/rows";
import { LiveDataError, type ScreenReader } from "@/data/live/types";
import { requireReader } from "@/data/load-reader";
import { getCommand } from "@/lib/commands";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ context: string; commandId: string }>;
}): Promise<Metadata> {
  const { commandId } = await params;
  return { title: `Command ${commandId.slice(0, 8)}` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The command page (live-lending.md §6.9.1, §6.9.4, T064b.3 fold 9): the first view is read on the
// server with the session's token; CommandLive keeps it current in the browser.
export default async function CommandPage({
  params,
}: {
  params: Promise<{ context: string; commandId: string }>;
}) {
  const { context, commandId } = await params;
  const path = `/${encodeURIComponent(context)}/commands/${encodeURIComponent(commandId)}`;
  let reader: ScreenReader;
  try {
    reader = await requireReader(path);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof LiveDataError) return <LiveFailurePage error={error} />;
    throw error;
  }
  if (reader.mode !== "live") notFound();
  const current = reader.context(context);
  if (!current || !UUID.test(commandId)) notFound();
  if (!process.env.NEXT_PUBLIC_API_URL)
    return (
      <LiveFailurePage error={new LiveDataError("CONFIG", "NEXT_PUBLIC_API_URL", "is not set")} />
    );

  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect(`/login?next=${encodeURIComponent(path)}`);
  const result = await getCommand(commandId, token);
  if (!result.ok) {
    if (result.code === "NOT_FOUND" || result.code === "VALIDATION") notFound();
    return <LiveFailurePage error={new LiveDataError("READ_FAILED", "getCommand", result.code)} />;
  }
  const view = result.data;
  // The lending kinds only (fold 1): field commands have pages of their own.
  if (!(COMMAND_KINDS as readonly string[]).includes(view.kind)) notFound();

  const organisations: Record<string, string> = {};
  for (const id of [
    view.initiatorOrganisationId,
    ...view.parties,
    ...view.signers.map(({ organisationId }) => organisationId),
  ]) {
    const named = reader.organisationByOrgId(id);
    if (named) organisations[id] = named.name;
  }
  const memberships = reader
    .contexts()
    .flatMap(({ organisationId }) => reader.orgIdOf(organisationId) ?? []);
  const lotId =
    view.lot === null
      ? null
      : (reader.lots(context).find(({ lending }) => lending?.lotAddress === view.lot)?.id ?? null);

  return (
    <LiveShell
      reader={reader}
      current={current}
      fallback={
        lotId === null ? `/${context}/queue` : `/${context}/lots/${encodeURIComponent(lotId)}`
      }
    >
      <CommandLive
        initial={view}
        context={context}
        memberships={memberships}
        organisations={organisations}
        lotId={lotId}
      />
    </LiveShell>
  );
}
