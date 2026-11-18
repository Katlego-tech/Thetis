import Link from "next/link";
import { PageHeader } from "@/components/thetis/page-header";

export default function ContextNotFound() {
  return (
    <section className="page-content">
      <PageHeader title="Page not found" />
      <Link className="page-link" href="/">
        Return to the work queue
      </Link>
    </section>
  );
}
