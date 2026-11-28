import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ReferenceBanner } from "@/components/shell/reference-banner";
import { SideRail } from "@/components/shell/side-rail";
import { SkipLink } from "@/components/shell/skip-link";
import { VoiceProvider } from "@/components/voice/voice-provider";
import { getReader } from "@/data/get-reader";
import { LiveDataError } from "@/data/live/types";
import { dataSource } from "@/data/load-reader";

export const dynamic = "force-dynamic";

export default async function ContextLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ context: string }>;
}) {
  // Live pages draw their own banner and rail from their own read; a bad source is the page's to report.
  let source: "reference" | "live" | null;
  try {
    source = dataSource();
  } catch (error) {
    if (!(error instanceof LiveDataError)) throw error;
    source = null;
  }
  // One voice session per organisation workspace, in both modes: this layout persists across
  // navigation inside the organisation, so a voice navigate_to never ends its own session.
  const { context } = await params;
  if (source !== "reference")
    return <VoiceProvider organisationId={context}>{children}</VoiceProvider>;

  const reader = getReader();
  const current = reader.context(context);
  if (!current) notFound();

  return (
    <VoiceProvider organisationId={context}>
      <SkipLink />
      <ReferenceBanner />
      <div className="workspace-shell">
        <SideRail current={current} reader={reader} />
        <main id="content" tabIndex={-1} className="workspace-main">
          <div className="page-content">{children}</div>
        </main>
      </div>
    </VoiceProvider>
  );
}
