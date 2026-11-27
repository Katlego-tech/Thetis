import { Archivo_400Regular } from "@expo-google-fonts/archivo/400Regular";
import { Archivo_600SemiBold } from "@expo-google-fonts/archivo/600SemiBold";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono/500Medium";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNetInfo } from "@react-native-community/netinfo";
import type { Session } from "@supabase/supabase-js";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, BackHandler, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createApiClient } from "./src/api/client";
import { commandsApi } from "./src/api/commands";
import { evidenceApi } from "./src/api/evidence";
import { walletLinksApi } from "./src/api/walletLinks";
import { type FieldConfig, readConfig } from "./src/config";
import { AppContext, type AppContextValue, type Route } from "./src/context";
import { type Membership, readMemberships, readProtocol } from "./src/data/reads";
import { createDraftStore, type StoredWallet } from "./src/drafts/store";
import type { ProtocolContext } from "./src/protocol";
import {
  ChooseOrganisation,
  ConfigError,
  LoadFailed,
  Loading,
  NoInstance,
  NoOrganisation,
} from "./src/screens/Gates";
import { Home } from "./src/screens/Home";
import { Intake } from "./src/screens/Intake";
import { IssueReview } from "./src/screens/IssueReview";
import { SignIn } from "./src/screens/SignIn";
import { Wallet } from "./src/screens/Wallet";
import { createSupabase } from "./src/supabase";
import type { WalletConnection } from "./src/wallet";

const store = createDraftStore(AsyncStorage);

export default function App() {
  const [fontsLoaded] = useFonts({
    Archivo_400Regular,
    Archivo_600SemiBold,
    JetBrainsMono_500Medium,
  });
  const config = useMemo(() => readConfig(), []);
  // The banner behind the status bar inverts in dark mode, so the status bar icons do too.
  const scheme = useColorScheme();
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === "dark" ? "dark" : "light"} />
      {config.ok ? <Configured config={config.config} /> : <ConfigError errors={config.errors} />}
    </SafeAreaProvider>
  );
}

function Configured(props: { config: FieldConfig }) {
  const db = useMemo(() => createSupabase(props.config), [props.config]);
  const net = useNetInfo();
  const online = net.isConnected !== false;
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    void db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = db.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [db]);

  // Supabase refreshes tokens only while the app is in the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") db.auth.startAutoRefresh();
      else db.auth.stopAutoRefresh();
    });
    return () => subscription.remove();
  }, [db]);

  const sessionExpired = useCallback(() => {
    setExpired(true);
    void db.auth.signOut({ scope: "local" });
  }, [db]);

  if (session === undefined) return <Loading />;
  if (session === null) return <SignIn db={db} online={online} expired={expired} />;
  return (
    <SignedIn
      config={props.config}
      db={db}
      session={session}
      online={online}
      sessionExpired={sessionExpired}
      signOut={() => {
        setExpired(false);
        void db.auth.signOut({ scope: "local" });
      }}
    />
  );
}

function SignedIn(props: {
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
  const [routes, setRoutes] = useState<Route[]>([{ name: "home" }]);
  const [tick, setTick] = useState(0);

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
    Promise.all([readMemberships(db, userId), store.organisation(userId)])
      .then(([rows, stored]) => {
        if (!live) return;
        setMemberships(rows);
        const only = rows.length === 1 ? rows[0]?.organisationId : undefined;
        setChosen(only ?? (rows.some((m) => m.organisationId === stored) ? stored : null));
      })
      .catch(() => live && setMembershipError(true));
    return () => {
      live = false;
    };
  }, [db, userId, tick]);

  const loadProtocol = useCallback(() => {
    setProtocolError(false);
    readProtocol(db, config.program)
      .then((result) => setProtocol(result.kind === "ready" ? result.context : "none"))
      .catch(() => setProtocolError(true));
  }, [db, config.program]);

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

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (routes.length <= 1) return false;
      setRoutes((stack) => stack.slice(0, -1));
      return true;
    });
    return () => subscription.remove();
  }, [routes.length]);

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
      store,
      user: { id: userId, email: props.session.user.email ?? "" },
      memberships,
      organisation,
      chooseOrganisation: (organisationId) => {
        setChosen(organisationId);
        setRoutes([{ name: "home" }]);
        if (organisationId) void store.setOrganisation(userId, organisationId);
      },
      protocol,
      refreshProtocol: loadProtocol,
      online,
      wallet,
      setWallet: async (next) => {
        setWalletState(next);
        await store.setWallet(userId, organisation.organisationId, next);
      },
      connection,
      setConnection,
      navigate: (route) =>
        setRoutes((stack) => (route.name === "home" ? [{ name: "home" }] : [...stack, route])),
      back: () => setRoutes((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)),
      sessionExpired: props.sessionExpired,
      signOut: props.signOut,
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
    wallet,
    connection,
    props.sessionExpired,
    props.signOut,
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
    return <LoadFailed offline={!online} what="The Thetis instance" onRetry={loadProtocol} />;
  }
  if (protocol === "none")
    return <NoInstance organisation={organisation.name} onRetry={loadProtocol} />;
  if (!value) return <Loading />;

  const route = routes.at(-1) ?? { name: "home" };
  return (
    <AppContext.Provider value={value}>
      {route.name === "home" ? (
        <Home key={organisation.organisationId} />
      ) : route.name === "wallet" ? (
        <Wallet />
      ) : route.name === "intake" ? (
        <Intake key={route.draftId} draftId={route.draftId} />
      ) : (
        <IssueReview key={`${route.draftId}-${routes.length}`} draftId={route.draftId} />
      )}
    </AppContext.Provider>
  );
}
