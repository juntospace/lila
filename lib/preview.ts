import {
  DEFAULT_NOTIFICATION_PREFS,
  type Database,
} from "@/lib/supabase/types";
import type { OperatorSession } from "@/lib/auth/guard";

/**
 * Preview mode bypasses Supabase Auth so the UI can be browsed without
 * a real Supabase project. Enabled via LILA_PREVIEW_MODE=1. Never enable
 * this in any deployed environment.
 */
export function isPreviewMode() {
  return process.env.LILA_PREVIEW_MODE === "1";
}

type Profile = Database["public"]["Tables"]["user_profiles"]["Row"];

export const PREVIEW_PROFILE: Profile = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "preview@junto.app",
  full_name: "Vero Preview",
  phone: "+507 6000 0000",
  role: "admin",
  language: "en",
  notification_prefs: DEFAULT_NOTIFICATION_PREFS,
  status: "active",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const PREVIEW_SESSION: OperatorSession = {
  userId: PREVIEW_PROFILE.id,
  email: PREVIEW_PROFILE.email,
  profile: PREVIEW_PROFILE,
};
