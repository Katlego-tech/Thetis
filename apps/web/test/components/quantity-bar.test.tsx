import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QuantityBar } from "@/components/thetis/quantity-bar";

afterEach(cleanup);

describe("QuantityBar", () => {
  it.each([
    [5000000n, 5000000n, 2000000n, "100%", "40%"],
    [5000000n, 0n, 0n, null, null],
    [0n, 0n, 0n, null, null],
    [18446744073709551615n, 6148914691236517205n, 2049638230412172401n, "33.33%", "11.11%"],
    [100n, 50n, 25n, "50%", "25%"],
  ])(
    "uses basis points for %s kg total, %s pledged and %s pending",
    (totalKg, pledgedKg, pendingKg, pledgedWidth, pendingWidth) => {
      render(
        <QuantityBar
          totalKg={totalKg}
          pledgedKg={pledgedKg}
          pendingKg={pendingKg}
          label="Lot quantity"
        />,
      );
      const bar = screen.getByRole("img", { name: /^Lot quantity/ });
      const pledged = bar.querySelector("[data-segment='pledged']");
      const pending = bar.querySelector("[data-segment='pending']");

      if (pledgedWidth === null) expect(pledged).toBeNull();
      else expect(pledged).toHaveStyle({ width: pledgedWidth });
      if (pendingWidth === null) expect(pending).toBeNull();
      else expect(pending).toHaveStyle({ width: pendingWidth });
    },
  );

  it("announces the total, pledged, nested pending and available quantities", () => {
    render(
      <QuantityBar
        totalKg={5000000n}
        pledgedKg={4000000n}
        pendingKg={2000000n}
        label="Lot quantity"
      />,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Lot quantity. Total 5,000.000 t. Pledged 4,000.000 t. Pending release within pledge 2,000.000 t. Available 1,000.000 t.",
    );
  });
});
