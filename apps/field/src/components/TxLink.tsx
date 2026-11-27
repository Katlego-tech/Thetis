import { Linking, View } from "react-native";
import { TextLink } from "./Button";
import { Txt } from "./Txt";

/** The transaction signature in mono with its explorer link. */
export function TxLink(props: { signature: string; explorerUrl: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Txt variant="mono" selectable>
        {props.signature}
      </Txt>
      <TextLink
        label="View on Solana Explorer (devnet)"
        onPress={() => void Linking.openURL(props.explorerUrl)}
      />
    </View>
  );
}
