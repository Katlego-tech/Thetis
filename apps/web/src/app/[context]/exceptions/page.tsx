import { ExceptionsScreen } from "@/components/queue/exceptions-screen";
import { getReader } from "@/data/get-reader";
import type { ExceptionView } from "@/data/types";

export default async function ExceptionsPage({ params }: { params: Promise<{ context: string }> }) {
  const { context } = await params;
  let cases: ExceptionView[] | null;
  try {
    cases = getReader().exceptions(context);
  } catch (error) {
    console.error("Could not load the exception queue", error);
    cases = null;
  }

  return <ExceptionsScreen organisationId={context} cases={cases} />;
}
