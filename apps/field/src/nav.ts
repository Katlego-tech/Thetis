// The per-tab route stacks (navigation.md §4.3, §6.2). Pure: no React, so every rule is tested in
// Vitest. Each tab keeps its own stack; leaving a tab keeps it, and coming back restores it.
import type { Route } from "./context";
import { NAV_COPY } from "./copy";

export type Tab = "home" | "account";

export interface NavState {
  tab: Tab;
  /** Each stack starts with the tab's root and is never empty. */
  stacks: Record<Tab, Route[]>;
}

export type NavAction =
  | { type: "push"; route: Route }
  | { type: "back" }
  | { type: "tab"; tab: Tab }
  | { type: "reset" };

export const tabRoots: Record<Tab, Route> = {
  home: { name: "home" },
  account: { name: "account" },
};

export const tabLabels: Record<Tab, string> = {
  home: NAV_COPY.tabHome,
  account: NAV_COPY.tabAccount,
};

export function initialNav(): NavState {
  return { tab: "home", stacks: { home: [tabRoots.home], account: [tabRoots.account] } };
}

/** The tab a route is the root of, or null for a pushed screen. */
function rootOf(route: Route): Tab | null {
  return route.name === "home" || route.name === "account" ? route.name : null;
}

/** Two routes are the same screen when their name and the record they open match. */
function sameRoute(a: Route, b: Route): boolean {
  const id = (r: Route) =>
    "draftId" in r ? r.draftId : "commandId" in r ? r.commandId : "intent" in r ? r.intent : "";
  return a.name === b.name && id(a) === id(b);
}

function withStack(state: NavState, tab: Tab, stack: Route[]): NavState {
  return { tab, stacks: { ...state.stacks, [tab]: stack } };
}

export function navReducer(state: NavState, action: NavAction): NavState {
  const stack = state.stacks[state.tab];
  switch (action.type) {
    case "push": {
      const root = rootOf(action.route);
      if (root) return withStack(state, root, [tabRoots[root]]);
      const at = stack.findIndex((r) => sameRoute(r, action.route));
      if (at >= 0) return withStack(state, state.tab, stack.slice(0, at + 1));
      return withStack(state, state.tab, [...stack, action.route]);
    }
    case "back":
      if (stack.length > 1) return withStack(state, state.tab, stack.slice(0, -1));
      if (state.tab !== "home") return { ...state, tab: "home" };
      return state;
    case "tab":
      if (action.tab === state.tab) return withStack(state, state.tab, [tabRoots[state.tab]]);
      return { ...state, tab: action.tab };
    case "reset":
      return initialNav();
  }
}

/** Android Back after the Picker: consumed while busy; unhandled only on the Home root. */
export function onBack(state: NavState, busy: boolean): { handled: boolean; next: NavState } {
  if (busy) return { handled: true, next: state };
  const next = navReducer(state, { type: "back" });
  return { handled: next !== state, next };
}

/** Home first and Account last: this build draws these two for every chain role (§3.2). */
export function tabsFor(_role: string | null): Tab[] {
  return ["home", "account"];
}

export function currentRoute(state: NavState): Route {
  const stack = state.stacks[state.tab];
  return stack[stack.length - 1] ?? tabRoots[state.tab];
}

export function isTabRoot(state: NavState): boolean {
  return state.stacks[state.tab].length === 1;
}
