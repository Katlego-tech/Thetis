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
import {
  copy,
  outcomeCopy,
  refusalCopy,
  roleCopy,
  routeCheckCopy,
  routeCopy,
} from "./src/lib/copy";
import {
  authorizationStatus,
  type Check,
  type Intent,
  type Outcome,
  type Role,
  type Route,
  roles,
  routes,
} from "./src/lib/relay";
import { getIntent, getOutcome, postSignature, RelayUnreachable } from "./src/relay-client";
import { connectWallet, signWithWallet, type WalletConnection } from "./src/wallet";

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

function OutcomePanel({ outcome, notice }: { outcome?: Outcome; notice?: Notice }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        {copy.outcome}
      </Text>
      {notice ? (
        <NoticeText notice={notice} />
      ) : (
        <Text accessibilityLiveRegion="polite">
          {outcome ? outcomeCopy[outcome.state] : copy.awaitingOutcome}
        </Text>
      )}
      {outcome?.signature && (
        <View>
          <Text>{copy.devnetSignature}</Text>
          <Text selectable>{outcome.signature}</Text>
        </View>
      )}
      {outcome?.sizeBytes !== undefined && <Text>{copy.size(outcome.sizeBytes)}</Text>}
      {outcome?.error !== undefined && <Text selectable>{outcome.error}</Text>}
      {roles.map((role) => (
        <View key={role} style={styles.section}>
          <Text style={styles.heading}>{roleCopy[role]}</Text>
          {routes.map((route) => (
            <View key={route}>
              <Text>{routeCheckCopy[route]}</Text>
              <CheckText check={outcome?.checks[role][route]} />
            </View>
          ))}
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
  const [lastCheck, setLastCheck] = useState<{ route: Route; result: Check }>();
  const pending = useRef(false);
  const { outcome, notice: outcomeNotice } = useOutcome();
  const expectedAddress = intent?.expectedAddress;
  const mismatch =
    connection !== undefined &&
    expectedAddress !== undefined &&
    connection.address !== expectedAddress;

  function selectRole(next: Role) {
    if (pending.current || next === role) return;
    setRole(next);
    setConnection(undefined);
    setIntent(undefined);
    setNotice(undefined);
    setLastCheck(undefined);
  }

  async function run(label: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setProgress(label);
    setNotice(undefined);
    try {
      await action();
    } catch (error) {
      setNotice(relayNotice(error));
    } finally {
      pending.current = false;
      setProgress(undefined);
    }
  }

  function connect() {
    void run(copy.connecting, async () => {
      setConnection(undefined);
      setLastCheck(undefined);
      try {
        setConnection(await connectWallet(expectedAddress));
      } catch (error) {
        setNotice({ title: copy.walletRefused, detail: errorText(error) });
      }
    });
  }

  function showStaleIntent() {
    setIntent(undefined);
    setNotice({ title: refusalCopy.INTENT_EXPIRED });
  }

  function loadIntent() {
    void run(copy.loading, async () => {
      const result = await getIntent(role).catch((error: unknown) => {
        setIntent(undefined);
        setLastCheck(undefined);
        throw error;
      });
      if (!("intent" in result) && result.reason === "CHAIN_UNAVAILABLE") {
        setNotice({ title: refusalCopy.CHAIN_UNAVAILABLE });
        return;
      }
      setLastCheck(undefined);
      if ("intent" in result) {
        setIntent(result);
      } else {
        setIntent(undefined);
        setNotice({ title: refusalCopy[result.reason] });
      }
    });
  }

  async function authorizationIsCurrent(loaded: Intent): Promise<boolean> {
    const latest = await getIntent(loaded.role);
    const submittedDigest =
      "reason" in latest && latest.reason === "BATCH_COMPLETE"
        ? (await getOutcome().catch(() => undefined))?.authorizationSha256
        : undefined;
    const status = authorizationStatus(loaded, latest, submittedDigest);
    if (status === "current") return true;
    if (status === "stale") {
      showStaleIntent();
    } else if (status === "batchComplete") {
      setIntent(undefined);
      setNotice({ title: refusalCopy.BATCH_COMPLETE });
    } else {
      setNotice({ title: refusalCopy[status] });
    }
    return false;
  }

  function sign(route: Route) {
    if (!intent || !connection || mismatch) return;
    void run(copy.checkingIntent, async () => {
      setLastCheck(undefined);
      if (!(await authorizationIsCurrent(intent))) return;
      setProgress(copy.signing);
      let signed: Awaited<ReturnType<typeof signWithWallet>>;
      try {
        signed = await signWithWallet(connection, intent, route, setConnection);
      } catch (error) {
        setNotice({ title: copy.walletRefused, detail: errorText(error) });
        return;
      }

      setProgress(copy.checkingIntent);
      if (!(await authorizationIsCurrent(intent))) return;
      setProgress(copy.sending);
      const result = await postSignature(signed);
      if (
        result.verified ||
        result.reason === "WRONG_ADDRESS" ||
        result.reason === "BAD_SIGNATURE"
      ) {
        setLastCheck({ route, result });
        if (!result.verified && result.reason === "BAD_SIGNATURE") {
          await authorizationIsCurrent(intent);
        }
      } else if (result.reason === "INTENT_EXPIRED") {
        showStaleIntent();
      } else {
        setNotice({ title: refusalCopy[result.reason] });
      }
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
      {connection && (
        <View>
          <Text>{copy.authorizedAddress}</Text>
          <Text selectable>{connection.address}</Text>
          {mismatch && <Text accessibilityLiveRegion="polite">{copy.walletMismatch}</Text>}
        </View>
      )}
      <Button title={copy.loadIntent} onPress={loadIntent} disabled={busy} />
      {intent && (
        <View style={styles.section}>
          <Text>{copy.expectedAddress}</Text>
          <Text selectable>{intent.expectedAddress}</Text>
          <Text style={styles.intent}>{intent.intent.text}</Text>
          <Text selectable>
            {copy.fingerprint} {intent.authorizationSha256.slice(0, 8)}
          </Text>
        </View>
      )}
      {routes.map((route) => (
        <Button
          key={route}
          title={routeCopy[route]}
          onPress={() => sign(route)}
          disabled={busy || !connection || mismatch || !intent}
        />
      ))}
      {progress && <Text accessibilityLiveRegion="polite">{progress}</Text>}
      {notice && <NoticeText notice={notice} />}
      {lastCheck && (
        <View accessibilityLiveRegion="polite">
          <Text>{routeCheckCopy[lastCheck.route]}</Text>
          <CheckText check={lastCheck.result} />
        </View>
      )}
      <OutcomePanel outcome={outcome} notice={outcomeNotice} />
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
  intent: { fontSize: 22 },
});
