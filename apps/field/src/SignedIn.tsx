// The app once a person is signed in: memberships, the organisation, the Thetis instance, then
// the route stack.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, BackHandler } from "react-native";
import { createApiClient } from "./api/client";
import { commandsApi } from "./api/commands";
import { evidenceApi } from "./api/evidence";
import { walletLinksApi } from "./api/walletLinks";
import type { FieldConfig } from "./config";
import { AppContext, type AppContextValue, type Route } from "./context";
import { type Membership, readMemberships, readProtocol } from "./data/reads";
import { createDraftStore, type StoredWallet } from "./drafts/store";
import type { ProtocolContext } from "./protocol";
import {
  ChooseOrganisation,
  LoadFailed,
  Loading,
  NoInstance,
  NoOrganisation,
} from "./screens/Gates";
import { Home } from "./screens/Home";
import { Intake } from "./screens/Intake";
import { IssueReview } from "./screens/IssueReview";
import { Wallet } from "./screens/Wallet";
import type { createSupabase } from "./supabase";
import type { WalletConnection } from "./wallet";

const store = createDraftStore(AsyncStorage);

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
