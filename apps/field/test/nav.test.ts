// navigation.md §4.3 and §8.2 (1 to 12): the per-tab route stacks, Android Back and the tabs.
import { describe, expect, it } from "vitest";
import {
  currentRoute,
  initialNav,
  isTabRoot,
  type NavAction,
  type NavState,
  navReducer,
  onBack,
  tabLabels,
  tabRoots,
  tabsFor,
} from "../src/nav";

function run(...actions: NavAction[]): NavState {
  return actions.reduce(navReducer, initialNav());
}

const intake = { name: "intake", draftId: "d-1" } as const;
const issue = { name: "issue", draftId: "d-1" } as const;

describe("navigation reducer (navigation.md §4.3)", () => {
  it("starts on the Home tab with each tab at its root", () => {
    const state = initialNav();
    expect(state.tab).toBe("home");
    expect(state.stacks).toEqual({ home: [{ name: "home" }], account: [{ name: "account" }] });
    expect(tabRoots).toEqual({ home: { name: "home" }, account: { name: "account" } });
    expect(tabLabels).toEqual({ home: "Home", account: "Account" });
    expect(currentRoute(state)).toEqual({ name: "home" });
    expect(isTabRoot(state)).toBe(true);
  });

  it("pushes a screen onto the current tab only", () => {
    const state = run({ type: "push", route: intake });
    expect(state.tab).toBe("home");
    expect(state.stacks.home).toEqual([{ name: "home" }, intake]);
    expect(state.stacks.account).toEqual([{ name: "account" }]);
    expect(currentRoute(state)).toEqual(intake);
    expect(isTabRoot(state)).toBe(false);
  });

  it("returns to a screen already in the stack instead of stacking a copy", () => {
    const state = run(
      { type: "push", route: intake },
      { type: "push", route: issue },
      { type: "push", route: { name: "intake", draftId: "d-1" } },
    );
    expect(state.stacks.home).toEqual([{ name: "home" }, intake]);
    const other = navReducer(state, { type: "push", route: { name: "intake", draftId: "d-2" } });
    expect(other.stacks.home).toHaveLength(3);
  });

  it("switches tab instead of pushing when navigating to home or account", () => {
    const onAccount = run(
      { type: "push", route: intake },
      { type: "push", route: { name: "account" } },
    );
    expect(onAccount.tab).toBe("account");
    expect(onAccount.stacks.account).toEqual([{ name: "account" }]);
    expect(onAccount.stacks.home).toEqual([{ name: "home" }, intake]);
    const home = navReducer(onAccount, { type: "push", route: { name: "home" } });
    expect(home.tab).toBe("home");
    expect(home.stacks.home).toEqual([{ name: "home" }]);
  });

  it("keeps each tab's stack when switching tabs", () => {
    const state = run(
      { type: "push", route: intake },
      { type: "tab", tab: "account" },
      { type: "tab", tab: "home" },
    );
    expect(state.tab).toBe("home");
    expect(currentRoute(state)).toEqual(intake);
  });

  it("returns the current tab to its root when it is chosen again", () => {
    const state = run(
      { type: "push", route: intake },
      { type: "push", route: issue },
      { type: "tab", tab: "home" },
    );
    expect(state.stacks.home).toEqual([{ name: "home" }]);
    expect(state.tab).toBe("home");
  });

  it("pops the current tab's stack on back", () => {
    const state = run(
      { type: "push", route: intake },
      { type: "push", route: issue },
      { type: "back" },
    );
    expect(state.stacks.home).toEqual([{ name: "home" }, intake]);
    const result = onBack(state, false);
    expect(result.handled).toBe(true);
    expect(result.next.stacks.home).toEqual([{ name: "home" }]);
  });

  it("goes to the Home tab on back from the Account root, keeping Home's stack", () => {
    const state = run({ type: "push", route: intake }, { type: "tab", tab: "account" });
    const result = onBack(state, false);
    expect(result.handled).toBe(true);
    expect(result.next.tab).toBe("home");
    expect(currentRoute(result.next)).toEqual(intake);
  });

  it("leaves back on the Home root to Android", () => {
    const state = initialNav();
    const result = onBack(state, false);
    expect(result.handled).toBe(false);
    expect(result.next).toBe(state);
    expect(navReducer(state, { type: "back" })).toBe(state);
  });

  it("ignores back while a wallet or relay call is in flight", () => {
    const state = run({ type: "push", route: intake }, { type: "push", route: issue });
    const result = onBack(state, true);
    expect(result.handled).toBe(true);
    expect(result.next).toBe(state);
    const root = onBack(initialNav(), true);
    expect(root.handled).toBe(true);
  });

  it("returns every tab to its root on Home after an organisation switch", () => {
    const state = run(
      { type: "push", route: intake },
      { type: "tab", tab: "account" },
      { type: "reset" },
    );
    expect(state).toEqual(initialNav());
  });

  it("gives every chain role Home and Account, in that order", () => {
    for (const role of ["Custodian", "Terminal", "Transporter", "Accreditor", null])
      expect(tabsFor(role)).toEqual(["home", "account"]);
  });
});
