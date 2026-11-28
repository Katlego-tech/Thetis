// The app once a person is signed in: memberships, the organisation, the Thetis instance, then
// the tabs with their route stacks (navigation.md §4).
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppState, BackHandler } from "react-native";
import { createApiClient } from "./api/client";
import { commandsApi } from "./api/commands";
import { evidenceApi } from "./api/evidence";
import { fieldApi } from "./api/field";
import { walletLinksApi } from "./api/walletLinks";
import { Picker } from "./components/Picker";
import type { FieldConfig } from "./config";
import { AppContext, type AppContextValue } from "./context";
import { NAV_COPY } from "./copy";
import {
  type Membership,
  ReadError,
  readChainOrganisation,
  readMemberships,
  readProtocol,
} from "./data/reads";
import { createDraftStore, type StoredWallet } from "./drafts/store";
import { currentRoute, initialNav, isTabRoot, navReducer, onBack, tabsFor } from "./nav";
import { createOfflineCache } from "./offline-cache";
import type { ProtocolContext } from "./protocol";
import { Batches } from "./screens/Batches";
import {
  ChooseOrganisation,
  LoadFailed,
  Loading,
  NoInstance,
  NoOrganisation,
} from "./screens/Gates";
import { Handover } from "./screens/Handover";
import { Home } from "./screens/Home";
import { Intake } from "./screens/Intake";
import { IssueReview } from "./screens/IssueReview";
import { Loading as LoadingIntent } from "./screens/Loading";
import { Loadings } from "./screens/Loadings";
import { Observation } from "./screens/Observation";
import { Wallet } from "./screens/Wallet";
import { type createSupabase, sessionStorage } from "./supabase";
import { VoiceProvider } from "./voice/VoiceProvider";
import type { WalletConnection } from "./wallet";

const store = createDraftStore(AsyncStorage);
const cache = createOfflineCache(sessionStorage);

/** A read that failed because the phone could not reach Supabase, not because it refused. */
function unreachable(error: unknown, online: boolean): boolean {
  if (!online) return true;
  if (error instanceof ReadError)
    return error.timeout || /Network request failed|fetch/i.test(error.message);
  return error instanceof TypeError;
}

/** The older of two cache times, or the one that is set. */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export function SignedIn(props: {
  config: FieldConfig;
  db: ReturnType<typeof createSupabase>;
  session: Session;
  online: boolean;
  sessionExpired: () => void;
  signOut: () => void;
}) {
  const { db, config, online } = props;
  const userId = props.session.user.id;
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [membershipError, setMembershipError] = useState(false);
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [protocol, setProtocol] = useState<ProtocolContext | "none" | null>(null);
  const [protocolError, setProtocolError] = useState(false);
  const [wallet, setWalletState] = useState<StoredWallet | null>(null);
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [nav, dispatch] = useReducer(navReducer, undefined, initialNav);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [tick, setTick] = useState(0);
  // The chosen organisation's chain role, for its tabs (navigation.md §3.2); null when unknown.
  const [chainRole, setChainRole] = useState<{ orgId: string; role: string | null } | null>(null);
  // Set while the gates run on what this phone read before (offline cold start); cleared by the
  // next successful read.
  const [membershipsCachedAt, setMembershipsCachedAt] = useState<string | null>(null);
  const [protocolCachedAt, setProtocolCachedAt] = useState<string | null>(null);
  const offlineSince = earliest(membershipsCachedAt, protocolCachedAt);

  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: config.apiUrl,
        getToken: async () => (await db.auth.getSession()).data.session?.access_token ?? null,
      }),
    [config.apiUrl, db],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read
  useEffect(() => {
    let live = true;
    setMembershipError(false);
    const choose = (rows: Membership[], stored: string | null) => {
      setMemberships(rows);
      const only = rows.length === 1 ? rows[0]?.organisationId : undefined;
      setChosen(only ?? (rows.some((m) => m.organisationId === stored) ? stored : null));
    };
    (async () => {
      const stored = await store.organisation(userId);
      try {
        const rows = await readMemberships(db, userId);
        if (!live) return;
        choose(rows, stored);
        setMembershipsCachedAt(null);
        await cache.setMemberships(userId, rows, new Date().toISOString());
      } catch (error) {
        const cached = unreachable(error, online) ? await cache.memberships(userId) : null;
        if (!live) return;
        if (!cached) return setMembershipError(true);
        choose(cached.value, stored);
        setMembershipsCachedAt(cached.savedAt);
      }
    })();
    return () => {
      live = false;
    };
  }, [db, userId, tick]);

  // Back online after an offline start: read everything again, which leaves offline mode.
  useEffect(() => {
    if (online && offlineSince !== null) setTick((t) => t + 1);
  }, [online, offlineSince]);

  const loadProtocol = useCallback(() => {
    setProtocolError(false);
    readProtocol(db, config.program)
      .then((result) => {
        setProtocol(result.kind === "ready" ? result.context : "none");
        setProtocolCachedAt(null);
        if (result.kind === "ready")
          void cache.setProtocol(userId, result.context, new Date().toISOString());
      })
      .catch(async (error: unknown) => {
        const cached = unreachable(error, online) ? await cache.protocol(userId) : null;
        if (!cached) return setProtocolError(true);
        setProtocol(cached.value);
        setProtocolCachedAt(cached.savedAt);
      });
  }, [db, config.program, userId, online]);

  useEffect(() => {
    if (memberships && memberships.length > 0) loadProtocol();
  }, [memberships, loadProtocol]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && memberships && memberships.length > 0) loadProtocol();
    });
    return () => subscription.remove();
  }, [memberships, loadProtocol]);

  useEffect(() => {
    if (!chosen) return;
    setConnection(null);
    void store.wallet(userId, chosen).then(setWalletState);
  }, [userId, chosen]);

  // The role is the chain's: read online, else this phone's last read for the organisation (the
  // facts useSigning stores). Nothing read means no role tab.
  const reachable = online && offlineSince === null;
  const instance = protocol && protocol !== "none" ? protocol.protocol : null;
  useEffect(() => {
    if (!chosen || !instance) return;
    let live = true;
    const cached = async () =>
      (await cache.signing(userId, chosen))?.value.chainOrganisation?.role ?? null;
    (async () => {
      let role: string | null;
      try {
        role = reachable
          ? ((await readChainOrganisation(db, instance, chosen))?.role ?? null)
          : await cached();
      } catch {
        role = await cached().catch(() => null);
      }
      if (live) setChainRole({ orgId: chosen, role });
    })();
    return () => {
      live = false;
    };
  }, [db, instance, chosen, userId, reachable]);

  const role = chainRole && chainRole.orgId === chosen ? chainRole.role : null;
  const tabs = useMemo(() => tabsFor(role), [role]);
  // A tab the role no longer has (the role read changed) is left for Home.
  useEffect(() => {
    if (!tabs.includes(nav.tab)) dispatch({ type: "tab", tab: "home" });
  }, [tabs, nav.tab]);

  // Android Back (navigation.md §4.3): an open Picker closes itself first (its Modal); then a call
  // in flight consumes the press; then onBack, which leaves only the Home root to Android.
  const latest = useRef({ nav, busy });
  latest.current = { nav, busy };
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      const { handled } = onBack(latest.current.nav, latest.current.busy);
      if (handled && !latest.current.busy) dispatch({ type: "back" });
      return handled;
    });
    return () => subscription.remove();
  }, []);

  const organisation = memberships?.find((m) => m.organisationId === chosen) ?? null;

  const value = useMemo<AppContextValue | null>(() => {
    if (!memberships || !organisation || !protocol || protocol === "none") return null;
    return {
      config,
      db,
      client,
      commands: commandsApi(client),
      walletLinks: walletLinksApi(client),
      evidence: evidenceApi(client),
      field: fieldApi(client),
      store,
      cache,
      user: { id: userId, email: props.session.user.email ?? "" },
      memberships,
      organisation,
      chooseOrganisation: (organisationId) => {
        // Cleared in the same render as the switch, so no frame shows one organisation's wallet
        // under another's name; the effect on `chosen` then reads the new one's.
        setWalletState(null);
        setConnection(null);
        setChosen(organisationId);
        dispatch({ type: "reset" });
        if (organisationId) void store.setOrganisation(userId, organisationId);
      },
      protocol,
      refreshProtocol: loadProtocol,
      // Offline mode: nothing that needs the network is offered until the reads succeed again.
      online: online && offlineSince === null,
      offlineSince,
      wallet,
      setWallet: async (next) => {
        setWalletState(next);
        await store.setWallet(userId, organisation.organisationId, next);
      },
      connection,
      setConnection,
      navigate: (route) => dispatch({ type: "push", route }),
      back: () => {
        if (!busy) dispatch({ type: "back" });
      },
      sessionExpired: props.sessionExpired,
      signOut: props.signOut,
      tab: nav.tab,
      tabs,
      openTab: (tab) => {
        if (!busy && tabs.includes(tab)) dispatch({ type: "tab", tab });
      },
      busy,
      setBusy,
      switchOrganisation: () => {
        if (memberships.length > 1 && !busy && isTabRoot(nav)) setChoosing(true);
      },
    };
  }, [
    memberships,
    organisation,
    protocol,
    config,
    db,
    client,
    userId,
    props.session.user.email,
    loadProtocol,
    online,
    offlineSince,
    wallet,
    connection,
    props.sessionExpired,
    props.signOut,
    nav,
    busy,
    tabs,
  ]);

  if (membershipError) {
    return (
      <LoadFailed
        offline={!online}
        what="Your organisations"
        onRetry={() => setTick((t) => t + 1)}
      />
    );
  }
  if (!memberships || chosen === undefined) return <Loading />;
  if (memberships.length === 0) return <NoOrganisation onSignOut={props.signOut} />;
  if (!organisation) {
    return (
      <ChooseOrganisation
        memberships={memberships}
        onChoose={(id) => {
          setChosen(id);
          void store.setOrganisation(userId, id);
        }}
      />
    );
  }
  if (protocolError) {
    return (
      <LoadFailed offline={!online} what="The Thetis instance details" onRetry={loadProtocol} />
    );
  }
  if (protocol === "none")
    return <NoInstance organisation={organisation.name} onRetry={loadProtocol} />;
  if (!value) return <Loading />;

  const route = currentRoute(nav);
  const depth = nav.stacks[nav.tab].length;
  return (
    <AppContext.Provider value={value}>
      {/* Keyed by organisation: a switch ends the voice session (voice.md §5.1). */}
      <VoiceProvider key={organisation.organisationId} onTabRoot={isTabRoot(nav)}>
        {route.name === "home" ? (
          <Home key={organisation.organisationId} />
        ) : route.name === "account" ? (
          <Wallet key={organisation.organisationId} />
        ) : route.name === "intake" ? (
          <Intake key={route.draftId} draftId={route.draftId} />
        ) : route.name === "issue" ? (
          <IssueReview key={`${route.draftId}-${depth}`} draftId={route.draftId} />
        ) : route.name === "batches" ? (
          <Batches key={depth} />
        ) : route.name === "handover" ? (
          <Handover key={`${route.commandId}-${depth}`} commandId={route.commandId} />
        ) : route.name === "loadings" ? (
          <Loadings key={depth} />
        ) : route.name === "loading" ? (
          <LoadingIntent key={`${route.intent}-${depth}`} intent={route.intent} />
        ) : (
          <Observation key={depth} />
        )}
        <Picker
          visible={choosing}
          title="Which organisation are you working for?"
          options={memberships.map((m) => ({
            key: m.organisationId,
            title: m.name,
            lines: [m.synthetic ? `${m.kind}, synthetic` : m.kind],
          }))}
          footnote={NAV_COPY.pickerFootnote}
          onPick={(key) => {
            setChoosing(false);
            value.chooseOrganisation(key);
          }}
          onClose={() => setChoosing(false)}
        />
      </VoiceProvider>
    </AppContext.Provider>
  );
}
