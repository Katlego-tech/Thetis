import { overviewColumns } from "@/components/dossier/overview-panels";
import { ResultTable } from "@/components/thetis/result-table";

const line = <div className="my-0.5 h-3 w-3/4 rounded bg-(--hair)" />;
const columns = [
  { key: "result", label: "Result" },
  { key: "value", label: "Value" },
  { key: "basis", label: "Basis" },
  { key: "attestor", label: "Attested by" },
  { key: "registry", label: "Registry" },
];
const row = { result: line, value: line, basis: line, attestor: line, registry: line };

export default function Loading() {
  return (
    <div role="status" className="grid gap-5">
      <span className="sr-only">Loading lot dossier</span>
      <div aria-hidden="true" className="grid gap-5">
        <div className="grid gap-2 border-b-2 border-(--ink) pb-3.5">
          <div className="h-7 w-2/3 rounded bg-(--hair)" />
          <div className="h-4 w-3/4 rounded bg-(--hair)" />
        </div>
        <div className="flex gap-4 border-b border-(--rule) p-2">
          {["Overview", "Evidence", "Financing", "Custody", "Activity"].map((tab) => (
            <div key={tab} className="h-4 w-14 rounded bg-(--hair)" />
          ))}
        </div>
        <div className={overviewColumns}>
          <div className="grid min-w-0 gap-5">
            <div className="grid gap-3 rounded border border-(--rule) bg-(--sheet) p-4">
              <div className="h-4 w-16 rounded bg-(--hair)" />
              <div className="h-7 rounded bg-(--hair)" />
              <div className="h-10 w-3/4 rounded bg-(--hair)" />
            </div>
            <ResultTable columns={columns} rows={[row, row, row, row, row]} totalRowIndex={4} />
          </div>
          <div className="grid gap-3 rounded border border-(--rule) bg-(--sheet) p-4">
            <div className="h-4 w-12 rounded bg-(--hair)" />
            <div className="h-9 w-full rounded bg-(--hair)" />
            <div className="h-8 w-32 rounded bg-(--hair)" />
          </div>
        </div>
      </div>
    </div>
  );
}
