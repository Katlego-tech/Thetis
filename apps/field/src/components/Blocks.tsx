import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { radius, usePalette } from "../theme";
import { Txt } from "./Txt";

export function Panel(props: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <View
      style={{
        backgroundColor: palette.sheet,
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        padding: 14,
        gap: 10,
      }}
    >
      {props.children}
    </View>
  );
}

/** Screen heading with the 2px ink rule under it. */
export function Head(props: { title: string; children?: ReactNode }) {
  const palette = usePalette();
  return (
    <View
      style={{ gap: 8, borderBottomWidth: 2, borderBottomColor: palette.ink, paddingBottom: 12 }}
    >
      <Txt variant="title" style={{ fontSize: 24 }}>
        {props.title}
      </Txt>
      {props.children}
    </View>
  );
}

export function Section(props: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Txt variant="section">{props.title}</Txt>
      {props.children}
    </View>
  );
}

export interface RowItem {
  label: string;
  value: ReactNode;
  sub?: string | null;
  mono?: boolean;
}

/** Key and value rows, as the summary tables in the references. */
export function Rows(props: { rows: readonly RowItem[] }) {
  const palette = usePalette();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        backgroundColor: palette.sheet,
      }}
    >
      {props.rows.map((row, index) => (
        <View
          key={row.label}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 12,
            paddingVertical: 9,
            paddingHorizontal: 12,
            borderBottomWidth: index === props.rows.length - 1 ? 0 : 1,
            borderBottomColor: palette.hair,
          }}
        >
          <Txt variant="small" tone="ink2">
            {row.label}
          </Txt>
          <View style={{ flexShrink: 1, alignItems: "flex-end" }}>
            {typeof row.value === "string" ? (
              <Txt variant={row.mono ? "mono" : "body"} style={{ textAlign: "right" }}>
                {row.value}
              </Txt>
            ) : (
              row.value
            )}
            {row.sub ? (
              <Txt variant="caption" tone="ink2" style={{ textAlign: "right" }}>
                {row.sub}
              </Txt>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/** A bordered list; each item is a pressable or plain row of at least 56 dp. */
export function ListBox(props: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        overflow: "hidden",
        backgroundColor: palette.sheet,
      }}
    >
      {props.children}
    </View>
  );
}

export function ListItem(props: {
  title: string;
  titleMono?: boolean;
  lines?: readonly string[];
  right?: ReactNode;
  last?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const palette = usePalette();
  const body = (
    <>
      <View style={{ flexShrink: 1, gap: 1 }}>
        <Txt
          variant={props.titleMono ? "mono" : "strong"}
          style={props.titleMono ? { fontSize: 14, lineHeight: 19 } : undefined}
        >
          {props.title}
        </Txt>
        {(props.lines ?? []).map((line) => (
          <Txt key={line} variant="caption" tone="ink2">
            {line}
          </Txt>
        ))}
      </View>
      {props.right ? <View style={{ alignItems: "flex-end", gap: 4 }}>{props.right}</View> : null}
    </>
  );
  const style = {
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    alignItems: "center" as const,
    gap: 12,
    borderBottomWidth: props.last ? 0 : 1,
    borderBottomColor: palette.hair,
  };
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      onPress={props.onPress}
      style={style}
    >
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}

export function Tag(props: { label: string }) {
  const palette = usePalette();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        paddingHorizontal: 6,
      }}
    >
      <Txt variant="caption" tone="ink2" style={{ fontSize: 11, lineHeight: 16 }}>
        {props.label}
      </Txt>
    </View>
  );
}

export function Skeleton(props: { width?: `${number}%`; height?: number }) {
  const palette = usePalette();
  return (
    <View
      accessibilityLabel="Loading"
      style={{
        height: props.height ?? 12,
        width: props.width ?? "80%",
        borderRadius: radius,
        backgroundColor: palette.hair,
      }}
    />
  );
}

export function Cert(props: { label: string }) {
  return (
    <Txt variant="mono" tone="ink2">
      {`devnet, ${props.label}`}
    </Txt>
  );
}
