import { supabaseBrowser } from "@/lib/supabase-browser";

let reportedConfigurationError = false;

export function accessAuth() {
  try {
    return supabaseBrowser().auth;
  } catch (error) {
    if (!reportedConfigurationError) {
      reportedConfigurationError = true;
      console.error(error);
    }
    return null;
  }
}
