import { notFound, redirect, unstable_rethrow } from "next/navigation";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { LiveDataError, type ScreenReader } from "@/data/live/types";
import { requireReader } from "@/data/load-reader";

export const dynamic = "force-dynamic";

export default async function Home() {
  let reader: ScreenReader;
  try {
    reader = await requireReader("/");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof LiveDataError) return <LiveFailurePage error={error} />;
    throw error;
  }
  const [context] = reader.contexts();
  if (!context) {
    if (reader.mode === "live") redirect("/account");
    notFound();
  }
  redirect(`/${context.organisationId}/queue`);
}
