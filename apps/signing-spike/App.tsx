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
import { copy, outcomeCopy, roleCopy, routeCheckCopy, routeCopy } from "./src/lib/copy";
import {
  type Check,
  expectedAddresses,
  type Intent,
  type Outcome,
  type Role,
  type Route,
  roles,
  routes,
  sameAuthorization,
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
      {check?.reason !== undefined && <Text selectable>{check.reason}</Text>}
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
  const expectedAddress = expectedAddresses[role];
  const mismatch = connection !== undefined && connection.address !== expectedAddress;

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
    setNotice({ title: copy.staleIntent });
  }

  function loadIntent() {
    void run(copy.loading, async () => {
      setIntent(undefined);
      setLastCheck(undefined);
      const result = await getIntent(role);
      if ("intent" in result) {
        setIntent(result);
      } else if (result.reason === "BATCH_COMPLETE") {
        setNotice({ title: copy.batchComplete });
      } else if (result.reason === "INTENT_EXPIRED") {
        showStaleIntent();
      } else {
        setNotice({ title: copy.relayError, detail: result.reason });
      }
    });
  }

  async function authorizationIsCurrent(loaded: Intent): Promise<boolean> {
    const latest = await getIntent(loaded.role);
    if ("intent" in latest) {
      if (sameAuthorization(loaded, latest)) return true;
      showStaleIntent();
      return false;
    }
    // The relay keeps verifying routes for the loaded bytes after submission.
    if (latest.reason === "BATCH_COMPLETE") return true;
    if (latest.reason === "INTENT_EXPIRED") {
      showStaleIntent();
    } else {
      setNotice({ title: copy.relayError, detail: latest.reason });
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
        signed = await signWithWallet(connection, intent, route);
        setConnection(signed.account);
      } catch (error) {
        setNotice({ title: copy.walletRefused, detail: errorText(error) });
        return;
      }

      setProgress(copy.sending);
      const result = await postSignature(signed.submission);
      setLastCheck({ route, result });
      if (result.reason === "INTENT_EXPIRED") {
        showStaleIntent();
      } else if (result.reason === "BAD_SIGNATURE") {
        await authorizationIsCurrent(intent);
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
          <View key={option} style={styles.role}>
            <Button
              title={roleCopy[option]}
              disabled={busy || role === option}
              onPress={() => selectRole(option)}
            />
            <Text>{copy.expectedAddress}</Text>
            <Text selectable>{expectedAddresses[option]}</Text>
          </View>
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
  role: { gap: 4 },
  title: { fontSize: 24, fontWeight: "bold" },
  heading: { fontSize: 16, fontWeight: "bold" },
  intent: { fontSize: 22 },
});
