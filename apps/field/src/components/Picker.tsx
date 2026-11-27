import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { radius, usePalette } from "../theme";
import { Tag } from "./Blocks";
import { Button } from "./Button";
import { Txt } from "./Txt";

export interface PickerOption {
  key: string;
  title: string;
  lines?: readonly string[];
  tag?: string | null;
  mono?: boolean;
}

/** The one list-selection sheet: site, owner, grade, organisation, wallet account. */
export function Picker(props: {
  visible: boolean;
  title: string;
  options: readonly PickerOption[];
  onPick: (key: string) => void;
  onClose: () => void;
  footnote?: string | null;
}) {
  const palette = usePalette();
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(17,21,23,0.45)" }}>
        <SafeAreaView
          edges={["bottom"]}
          style={{ backgroundColor: palette.paper, borderTopWidth: 2, borderTopColor: palette.ink }}
        >
          <View style={{ padding: 16, gap: 12, maxHeight: 560 }}>
            <Txt variant="section">{props.title}</Txt>
            <ScrollView contentContainerStyle={{ gap: 8 }}>
              {props.options.map((option) => (
                <Pressable
                  key={option.key}
                  accessibilityRole="button"
                  accessibilityLabel={option.title}
                  onPress={() => props.onPick(option.key)}
                  style={{
                    minHeight: 56,
                    borderWidth: 1,
                    borderColor: palette.rule,
                    borderRadius: radius,
                    backgroundColor: palette.sheet,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <View style={{ flexShrink: 1, gap: 2 }}>
                    <Txt
                      variant={option.mono ? "mono" : "strong"}
                      style={option.mono ? { fontSize: 14 } : undefined}
                    >
                      {option.title}
                    </Txt>
                    {(option.lines ?? []).map((line) => (
                      <Txt key={line} variant="caption" tone="ink2">
                        {line}
                      </Txt>
                    ))}
                  </View>
                  {option.tag ? <Tag label={option.tag} /> : null}
                </Pressable>
              ))}
            </ScrollView>
            {props.footnote ? (
              <Txt variant="small" tone="ink2">
                {props.footnote}
              </Txt>
            ) : null}
            <Button label="Close" kind="quiet" onPress={props.onClose} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** The one confirmation sheet (discard draft). */
export function ConfirmSheet(props: {
  visible: boolean;
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const palette = usePalette();
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.onCancel}
    >
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(17,21,23,0.45)" }}>
        <SafeAreaView
          edges={["bottom"]}
          style={{ backgroundColor: palette.paper, borderTopWidth: 2, borderTopColor: palette.ink }}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Txt variant="section">{props.title}</Txt>
            <Txt style={{ fontSize: 14 }}>{props.body}</Txt>
            <Button label={props.confirm} onPress={props.onConfirm} />
            <Button label={props.cancel} kind="quiet" onPress={props.onCancel} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
