import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  StatusBar as NativeStatusBar,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { copy, outcomeCopy, refusalCopy, roleCopy } from "./src/lib/copy";
import {
  type Check,
  type Intent,
  type Outcome,
  type Role,
  roles,
  sameIntent,
} from "./src/lib/relay";
import { getIntent, getOutcome, postSignature, RelayUnreachable } from "./src/relay-client";
import {
  connectWallet,
  signIntent,
  WalletAccountError,
  type WalletConnection,
  WalletRefused,
} from "./src/wallet";

const POLL_INTERVAL_MS = 3_000;

type Notice = { title: string; detail?: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relayNotice(error: unknown): Notice {
  return error instanceof RelayUnreachable
    ? { title: copy.relayUnreachable }
    : { title: copy.relayError, detail: errorText(error) };
}

function useOutcome() {
  const [outcome, setOutcome] = useState<Outcome>();
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    let active = true;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const result = await getOutcome();
        if (!active) return;
        setOutcome(result);
        setNotice(undefined);
      } catch (error) {
        if (!active) return;
        setOutcome(undefined);
        setNotice(relayNotice(error));
      } finally {
        polling = false;
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);
  return { outcome, notice };
}

function NoticeText({ notice }: { notice: Notice }) {
  return (
    <View accessibilityLiveRegion="polite">
      <Text>{notice.title}</Text>
      {notice.detail !== undefined && <Text selectable>{notice.detail}</Text>}
    </View>
  );
}

function CheckText({ check }: { check?: Check }) {
  return (
    <View>
      <Text>{check ? copy.verified(check.verified) : copy.notChecked}</Text>
      {check?.verified === false && <Text selectable>{refusalCopy[check.reason]}</Text>}
    </View>
  );
}

function OutcomePanel({
  outcome,
  notice,
  intentDigest,
}: {
  outcome?: Outcome;
  notice?: Notice;
  intentDigest?: string;
}) {
  const outcomeDigest = outcome?.submittedMessageSha256;
  const differentBytes =
    intentDigest !== undefined && outcomeDigest !== undefined && intentDigest !== outcomeDigest;
  const currentOutcome =
    intentDigest === undefined ||
    (outcome?.state === "waiting" ? outcome.activeMessageSha256 : outcomeDigest) === intentDigest
      ? outcome
      : undefined;
  const checksDigest = outcomeDigest ?? outcome?.activeMessageSha256;
  const checks =
    intentDigest === undefined || checksDigest === intentDigest ? outcome?.checks : undefined;
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        {copy.outcome}
      </Text>
      {outcomeDigest !== undefined && (
        <Text selectable>{`${copy.fingerprint} ${outcomeDigest.slice(0, 8)}`}</Text>
      )}
      {notice || differentBytes ? (
        <NoticeText notice={notice ?? { title: copy.outcomeMismatch }} />
      ) : (
        <Text accessibilityLiveRegion="polite">
          {currentOutcome
            ? outcomeCopy[currentOutcome.state]
            : outcome
              ? copy.awaitingIntentOutcome
              : copy.awaitingOutcome}
        </Text>
      )}
      {currentOutcome?.signature && (
        <View>
          <Text>{copy.devnetSignature}</Text>
          <Text selectable>{currentOutcome.signature}</Text>
        </View>
      )}
      {currentOutcome?.sizeBytes !== undefined && (
        <Text>{copy.size(currentOutcome.sizeBytes)}</Text>
      )}
      {currentOutcome?.error !== undefined && <Text selectable>{currentOutcome.error}</Text>}
      {roles.map((role) => (
        <View key={role} style={styles.section}>
          <Text style={styles.heading}>{roleCopy[role]}</Text>
          <CheckText check={checks?.[role]} />
        </View>
      ))}
    </View>
  );
}

export default function App() {
  const [role, setRole] = useState<Role>("sender");
  const [connection, setConnection] = useState<WalletConnection>();
  const [intent, setIntent] = useState<Intent>();
  const [progress, setProgress] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [payloadMismatch, setPayloadMismatch] = useState<number | null>();
  const [lastCheck, setLastCheck] = useState<Check>();
  const pending = useRef(false);
  const { outcome, notice: outcomeNotice } = useOutcome();
  const expectedAddress = intent?.expectedAddress;
  const matchingAccount = connection?.accounts.find(({ address }) => address === expectedAddress);
  const displayedAccount = matchingAccount ?? connection?.accounts[0];
  const mismatch =
    connection !== undefined && expectedAddress !== undefined && matchingAccount === undefined;

  function selectRole(next: Role) {
    if (pending.current || next === role) return;
    setRole(next);
    setConnection(undefined);
    setIntent(undefined);
    setNotice(undefined);
    setPayloadMismatch(undefined);
    setLastCheck(undefined);
  }

  async function run(label: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setProgress(label);
    setNotice(undefined);
    setPayloadMismatch(undefined);
    try {
      await action();
    } catch (error) {
      if (error instanceof WalletRefused) {
        setNotice({ title: copy.walletRefused, detail: error.message });
      } else if (error instanceof WalletAccountError) {
        setNotice({ title: error.message });
      } else {
        setNotice(relayNotice(error));
      }
    } finally {
      pending.current = false;
      setProgress(undefined);
    }
  }

  function connect() {
    void run(copy.connecting, async () => {
      setConnection(undefined);
      setLastCheck(undefined);
      setConnection(await connectWallet());
    });
  }

  function loadIntent() {
    void run(copy.loading, async () => {
      const result = await getIntent(role).catch((error: unknown) => {
        setIntent(undefined);
        setLastCheck(undefined);
        throw error;
      });
      if (!("messageText" in result) && result.reason === "CHAIN_UNAVAILABLE") {
        setNotice({ title: refusalCopy.CHAIN_UNAVAILABLE });
        return;
      }
      setLastCheck(undefined);
      if ("messageText" in result) {
        setIntent(result);
      } else {
        setIntent(undefined);
        setNotice({ title: refusalCopy[result.reason] });
      }
    });
  }

  async function intentIsCurrent(loaded: Intent): Promise<boolean> {
    const latest = await getIntent(loaded.role);
    if ("messageText" in latest && sameIntent(loaded, latest)) return true;

    const reason = "messageText" in latest ? "STALE_INTENT" : latest.reason;
    if (reason !== "CHAIN_UNAVAILABLE") {
      setIntent(undefined);
      setLastCheck(undefined);
    }
    setNotice({ title: refusalCopy[reason] });
    return false;
  }

  function sign() {
    if (!intent || !connection || mismatch) return;
    void run(copy.checkingIntent, async () => {
      setLastCheck(undefined);
      if (!(await intentIsCurrent(intent))) return;
      setProgress(copy.signing);
      const signed = await signIntent(connection, intent, setConnection, async () => {
        setProgress(copy.checkingIntent);
        if (!(await intentIsCurrent(intent))) return false;
        setProgress(copy.signing);
        return true;
      });
      if (!signed) return;
      setPayloadMismatch(signed.payloadMismatch);
      if (!signed.submission) return;

      setProgress(copy.checkingIntent);
      if (!(await intentIsCurrent(intent))) return;
      setProgress(copy.sending);
      const result = await postSignature(signed.submission);
      setLastCheck(result);
      if (!result.verified && result.reason === "STALE_INTENT") setIntent(undefined);
    });
  }

  const busy = progress !== undefined;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <StatusBar style="dark" />
      <Text accessibilityRole="header" style={styles.title}>
        {copy.title}
      </Text>
      <View style={styles.section}>
        {roles.map((option) => (
          <Button
            key={option}
            title={roleCopy[option]}
            disabled={busy || role === option}
            onPress={() => selectRole(option)}
          />
        ))}
      </View>
      <Button title={copy.connect} onPress={connect} disabled={busy} />
      {displayedAccount && (
        <View>
          <Text>{copy.authorizedAddress}</Text>
          <Text selectable>{displayedAccount.address}</Text>
          {mismatch && <Text accessibilityLiveRegion="polite">{copy.walletMismatch}</Text>}
        </View>
      )}
      <Button title={copy.loadIntent} onPress={loadIntent} disabled={busy} />
      {intent && (
        <View style={styles.section}>
          <Text>{copy.expectedAddress}</Text>
          <Text selectable>{intent.expectedAddress}</Text>
          <Text selectable style={styles.intent}>
            {intent.messageText}
          </Text>
          <Text selectable>{`${copy.fingerprint} ${intent.messageSha256.slice(0, 8)}`}</Text>
        </View>
      )}
      <Button
        title={copy.sign}
        onPress={sign}
        disabled={busy || !connection || mismatch || !intent}
      />
      {progress && <Text accessibilityLiveRegion="polite">{progress}</Text>}
      {notice && <NoticeText notice={notice} />}
      {payloadMismatch !== undefined && (
        <NoticeText
          notice={{
            title: copy.payloadMismatch,
            detail: copy.receivedPayloadLength(payloadMismatch),
          }}
        />
      )}
      {lastCheck && <CheckText check={lastCheck} />}
      <OutcomePanel outcome={outcome} notice={outcomeNotice} intentDigest={intent?.messageSha256} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    backgroundColor: "#fff",
    flexGrow: 1,
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: (NativeStatusBar.currentHeight ?? 0) + 12,
    paddingBottom: 48,
  },
  section: { gap: 8 },
  title: { fontSize: 24, fontWeight: "bold" },
  heading: { fontSize: 16, fontWeight: "bold" },
  intent: { fontSize: 16, fontFamily: "monospace" },
});
