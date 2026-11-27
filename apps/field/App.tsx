import { Archivo_400Regular } from "@expo-google-fonts/archivo/400Regular";
import { Archivo_600SemiBold } from "@expo-google-fonts/archivo/600SemiBold";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono/500Medium";
import { useNetInfo } from "@react-native-community/netinfo";
import type { Session } from "@supabase/supabase-js";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { type FieldConfig, readConfig } from "./src/config";
import { SignedIn } from "./src/SignedIn";
import { ConfigError, Loading } from "./src/screens/Gates";
import { SignIn } from "./src/screens/SignIn";
import { createSupabase } from "./src/supabase";

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
