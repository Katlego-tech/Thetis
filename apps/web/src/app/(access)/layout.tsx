import type { ReactNode } from "react";
import { TestBanner, TopBar } from "@/components/access/access-shell";
import "./access.css";

export default function AccessLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <TestBanner />
      <TopBar />
      <main className="access-main">{children}</main>
    </>
  );
}
