// Flattens a React element tree to its visible strings, calling function components, so a
// component can be checked in Node without a native renderer.
import { isValidElement, type ReactNode } from "react";

export function textOf(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (!isValidElement(node)) return [];
  const { type, props } = node as { type: unknown; props: { children?: ReactNode } };
  if (typeof type === "function") return textOf((type as (p: unknown) => ReactNode)(props));
  return textOf(props.children);
}

/** Text runs joined per Text element are what a person reads; this joins adjacent strings. */
export function linesOf(node: ReactNode): string {
  return textOf(node).join("");
}
