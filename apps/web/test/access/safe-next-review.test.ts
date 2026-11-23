import { expect, test } from "vitest";
import { safeNext } from "@/lib/safe-next";

test.each(["/%6Cogin", "/login//", "/a//b", "/a%20b"])(
  "rejects percent signs and repeated slashes in the path %s",
  (path) => expect(safeNext(path)).toBe("/account"),
);

test("preserves percent signs and repeated slashes in query and fragment values", () => {
  const path = "/invite?next=%2Fa//b#%2F//";
  expect(safeNext(path)).toBe(path);
});
