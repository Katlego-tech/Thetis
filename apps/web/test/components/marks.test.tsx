import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { StateMark } from "@/components/thetis/state-mark";
import type { RegistryStatus } from "@/data/types";

afterEach(cleanup);

describe("RegistryMark", () => {
  const marks: [RegistryStatus, string, string, string, string][] = [
    ["not_submitted", "Not on chain", "border-dashed", "border-(--ink-2)", "text-(--ink)"],
    ["draft", "Draft", "border-dashed", "border-(--ink-2)", "text-(--ink)"],
    [
      "awaiting_signatures",
      "Awaiting signatures",
      "border-dashed",
      "border-(--ink)",
      "text-(--ink)",
    ],
    ["submitted", "Submitted, unconfirmed", "border-dashed", "border-(--ink)", "text-(--ink)"],
    ["confirmed", "Confirmed", "border-solid", "border-(--ink)", "text-(--ink)"],
    ["finalized", "Finalized", "border-solid", "border-(--ink)", "text-(--ink)"],
    ["failed", "Failed", "border-solid", "border-(--refuse)", "text-(--refuse)"],
    ["outcome_unknown", "Outcome unknown", "border-dashed", "border-(--refuse)", "text-(--refuse)"],
  ];

  it.each(marks)(
    "%s shows %s with the specified border and ink",
    (status, label, style, border, ink) => {
      render(<RegistryMark status={status} />);
      const mark = screen.getByText(label);
      expect(mark).toHaveClass("border", style, border, ink);
      expect(mark).not.toHaveClass(style === "border-dashed" ? "border-solid" : "border-dashed");
      if (status === "finalized") expect(mark).toHaveClass("font-semibold");
    },
  );
});

describe("StateMark", () => {
  it.each([
    ["Custody", "Partly arrived"],
    ["Finance", "External hand-off"],
    ["Restriction", "Review required"],
    ["Payment", "Reported by buyer"],
  ] as const)("shows the %s dimension and value", (dimension, value) => {
    render(<StateMark dimension={dimension} value={value} />);
    const prefix = screen.getByText(dimension);
    expect(prefix).toHaveClass("text-(--ink-2)");
    expect(prefix.parentElement).toHaveTextContent(`${dimension} ${value}`);
    expect(prefix.parentElement).toHaveClass("border-dashed", "border-(--ink-2)");
  });
});
