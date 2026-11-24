import { expect, test } from "vitest";
import { isExpiredResponse, loginHref } from "@/components/access/session-expired";

const TOKEN = "a".repeat(64);

test("loginHref carries next and no reason when the session has not expired", () => {
  expect(loginHref("/account", false)).toBe("/login?next=%2Faccount");
});

test("loginHref adds reason=expired and keeps a full invite path in next", () => {
  const next = `/invite?token=${TOKEN}`;
  const url = new URL(loginHref(next, true), "http://h");
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe(next);
  expect(url.searchParams.get("reason")).toBe("expired");
});

test("isExpiredResponse is true for a 401 status", () => {
  expect(isExpiredResponse({ status: 401 })).toBe(true);
});

test("isExpiredResponse is true for PGRST301", () => {
  expect(isExpiredResponse({ error: { code: "PGRST301" } })).toBe(true);
});

test("isExpiredResponse is true for PGRST303", () => {
  expect(isExpiredResponse({ error: { code: "PGRST303" } })).toBe(true);
});

test("isExpiredResponse is false for a refusal from the database", () => {
  expect(isExpiredResponse({ status: 400, error: { code: "P0001" } })).toBe(false);
});

test("isExpiredResponse is false for a successful response", () => {
  expect(isExpiredResponse({ status: 200, error: null })).toBe(false);
});
