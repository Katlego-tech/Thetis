import { View } from "react-native";
import { RELAY_TIMEOUT } from "../copy";
import type { Phase, Problem } from "../data/useCommandSigning";
import { shortAddress } from "../format";
import { OTHER_INSTANCE } from "../protocol";
import type { TextMismatch } from "../text";
import { ErrorBlock, Note } from "./Note";
import { Txt } from "./Txt";

/**
 * The notes every signing screen shows around its text: what the wallet is doing, what went
 * wrong and why the wallet was not opened. `noun` names the thing being sent to devnet.
 */
export function SigningNotes(props: {
  noun: "handover" | "observation" | "loading";
  org: string;
  walletAddress: string | null;
  problem: Problem;
  phase: Phase;
  signBefore: string;
  mismatches: readonly TextMismatch[];
  otherInstance: boolean;
  /** The command is waiting for signatures but no wallet is stored on this phone. */
  needsWallet: boolean;
}) {
  const { problem, phase } = props;
  return (
    <>
      {problem?.kind === "offline_waiting" ? (
        <Note>
          Offline. This phone can't see the outcome. Thetis keeps checking devnet; the result shows
          here when you are back online.
        </Note>
      ) : null}
      {problem?.kind === "signature_stale" ? (
        <Note>
          The text changed after you signed it. Your signature was not sent. Sign the new text.
        </Note>
      ) : null}
      {problem?.kind === "timeout" ? <ErrorBlock>{RELAY_TIMEOUT}</ErrorBlock> : null}
      {problem?.kind === "relay" ? <ErrorBlock>{problem.text}</ErrorBlock> : null}

      {props.otherInstance ? (
        <ErrorBlock>{`${OTHER_INSTANCE} Your wallet was not opened.`}</ErrorBlock>
      ) : props.mismatches.length > 0 ? (
        <ErrorBlock>
          <Txt tone="refuse" style={{ fontSize: 14 }}>
            The text from Thetis does not match what you entered. Your wallet was not opened.
          </Txt>
          {props.mismatches.map((m) => (
            <View key={`${m.line}-${m.label}`} style={{ gap: 2 }}>
              <Txt variant="mono" tone="refuse">{`Line ${m.line}, ${m.label}`}</Txt>
              <Txt variant="mono" tone="refuse">{`Expected ${m.expected}`}</Txt>
              <Txt variant="mono" tone="refuse">{`Received ${m.actual ?? "nothing"}`}</Txt>
            </View>
          ))}
          <Txt tone="refuse" style={{ fontSize: 14 }}>
            Report this. Do not sign a text that does not match what is in front of you.
          </Txt>
        </ErrorBlock>
      ) : null}

      {phase.kind === "wallet" ? (
        <Note>
          Approve the signature in your wallet. Check that it shows the same text as this screen.
        </Note>
      ) : null}
      {phase.kind === "sending" ? (
        <Note>{`Thetis is checking your signature and sending the ${props.noun} to devnet.`}</Note>
      ) : null}
      {phase.kind === "not_sent" ? (
        <ErrorBlock>{`Your signature was not sent. Send it again before ${props.signBefore}. If you leave this screen, you will need to sign again.`}</ErrorBlock>
      ) : null}
      {problem?.kind === "wallet_refused" ? (
        <ErrorBlock>{`Your wallet closed without signing. Nothing was signed or sent. You can sign this text until ${props.signBefore}.`}</ErrorBlock>
      ) : null}
      {problem?.kind === "wrong_account" && props.walletAddress ? (
        <ErrorBlock>
          {`Your wallet did not offer ${shortAddress(props.walletAddress)}, the wallet linked for ${props.org}. Choose that account in the wallet and try again.`}
        </ErrorBlock>
      ) : null}
      {problem?.kind === "text_changed" ? (
        <Note>
          The text changed before your wallet opened. Nothing was signed. Check the new text below.
        </Note>
      ) : null}
      {problem?.kind === "payload" ? (
        <ErrorBlock>
          {`Your wallet returned something other than a signature of this text (${problem.bytes ?? 0} bytes). Nothing was sent. Try another wallet and report the wallet name with this message.`}
        </ErrorBlock>
      ) : null}
      {props.needsWallet ? <Note>Connect a wallet first.</Note> : null}
    </>
  );
}
