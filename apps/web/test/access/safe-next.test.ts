import { expect, test } from "vitest";
import { safeNext } from "@/lib/safe-next";

test("safeNext keeps same-origin paths with their query", () => {
  expect(safeNext("/invite?token=ab")).toBe("/invite?token=ab");
  expect(safeNext("/account")).toBe("/account");
});

test("safeNext falls back to /account for anything else", () => {
  expect(safeNext(null)).toBe("/account");
  expect(safeNext("")).toBe("/account");
  expect(safeNext("account")).toBe("/account");
  expect(safeNext("//evil.example")).toBe("/account");
  expect(safeNext("/\\evil.example")).toBe("/account");
  expect(safeNext("https://evil.example")).toBe("/account");
  expect(safeNext("javascript:alert(1)")).toBe("/account");
});

test.each(["/login", "/login?next=/invite", "/login#form", "/with space", "/x\u0000", "/x\u007f"])(
  "safeNext refuses unsafe return path %j",
  (path) => expect(safeNext(path)).toBe("/account"),
);
