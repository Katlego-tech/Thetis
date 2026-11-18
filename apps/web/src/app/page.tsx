import { notFound, redirect } from "next/navigation";
import { getReader } from "@/data/get-reader";

export default function Home() {
  const [context] = getReader().contexts();
  if (!context) notFound();
  redirect(`/${context.organisationId}/queue`);
}
