import type { ReactNode } from "react";

export function PageHeader({
  title,
  sub,
  aside,
}: {
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {sub != null && <div className="page-subtitle">{sub}</div>}
      </div>
      {aside != null && <div className="page-aside">{aside}</div>}
    </header>
  );
}
