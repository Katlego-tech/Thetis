import { View } from "react-native";
import { usePalette } from "../theme";
import { Skeleton } from "./Blocks";
import { Txt } from "./Txt";

/** The exact text the wallet will sign, every line, selectable; or its skeleton while preparing. */
export function SignedText(props: {
  text: string | null;
  byteLine?: string | null;
  check?: string | null;
}) {
  const palette = usePalette();
  return (
    <View style={{ gap: 8 }}>
      <Txt variant="section">You will sign exactly this text</Txt>
      {props.text === null ? (
        <Skeleton width="100%" height={140} />
      ) : (
        <View
          style={{
            backgroundColor: palette.sheet,
            borderLeftWidth: 2,
            borderLeftColor: palette.ink,
            paddingVertical: 10,
            paddingHorizontal: 12,
          }}
        >
          <Txt variant="signed" selectable>
            {props.text}
          </Txt>
        </View>
      )}
      {props.byteLine ? (
        <Txt variant="mono" tone="ink2">
          {props.byteLine}
        </Txt>
      ) : null}
      {props.check ? (
        <Txt variant="small" tone="ink2">
          {props.check}
        </Txt>
      ) : null}
    </View>
  );
}
