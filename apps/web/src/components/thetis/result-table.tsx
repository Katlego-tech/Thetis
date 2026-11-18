import type { ReactNode } from "react";

export function ResultTable({
  columns,
  rows,
  totalRowIndex,
  totalRowIndexes,
}: {
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, ReactNode>[];
  totalRowIndex?: number;
  totalRowIndexes?: number[];
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: The stacked mobile layout changes table display modes.
    <table className="result-table" role="table">
      {/* biome-ignore lint/a11y/noRedundantRoles: Positioning the header offscreen changes its display mode. */}
      <thead role="rowgroup">
        <tr>
          {columns.map(({ key, label, align }) => (
            <th key={key} scope="col" data-align={align}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      {/* biome-ignore lint/a11y/noRedundantRoles: The stacked mobile layout changes the row group's display mode. */}
      <tbody role="rowgroup">
        {rows.map((row, index) => (
          <tr
            // biome-ignore lint/suspicious/noArrayIndexKey: The contract supplies position and cell contents, with no row ID.
            key={index}
            // biome-ignore lint/a11y/noRedundantRoles: A mobile row is displayed as a block.
            role="row"
            data-total={index === totalRowIndex || totalRowIndexes?.includes(index) || undefined}
          >
            {columns.map(({ key, label, align }) => (
              // biome-ignore lint/a11y/noRedundantRoles: A mobile cell is displayed as a grid.
              <td key={key} role="cell" data-align={align}>
                <span className="result-mobile-label" aria-hidden="true">
                  {label}
                </span>
                <div>{row[key]}</div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
