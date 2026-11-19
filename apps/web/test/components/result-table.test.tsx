import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ResultTable } from "@/components/thetis/result-table";

afterEach(cleanup);

const columns = [{ key: "line", label: "Line" }];
const rows = [{ line: "First" }, { line: "Second" }, { line: "Third" }];

it("styles several totals by row index", () => {
  render(<ResultTable columns={columns} rows={rows} totalRowIndexes={[0, 2]} />);
  expect(screen.getByRole("row", { name: "First" })).toHaveAttribute("data-total", "true");
  expect(screen.getByRole("row", { name: "Second" })).not.toHaveAttribute("data-total");
  expect(screen.getByRole("row", { name: "Third" })).toHaveAttribute("data-total", "true");
});

it("still styles a single total specified using totalRowIndex", () => {
  render(<ResultTable columns={columns} rows={rows} totalRowIndex={1} />);
  expect(screen.getByRole("row", { name: "First" })).not.toHaveAttribute("data-total");
  expect(screen.getByRole("row", { name: "Second" })).toHaveAttribute("data-total", "true");
  expect(screen.getByRole("row", { name: "Third" })).not.toHaveAttribute("data-total");
});
