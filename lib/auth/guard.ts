import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  DEFAULT_NOTIFICATION_PREFS,
  type Database,
} from "@/lib/supabase/types";

type UserProfile = Database["public"]["Tables"]["user_profiles"]["Row"];

export type OperatorSession = {
  userId: string;
  email: string;
  profile: UserProfile;
};

/**
 * Guard for any operator-only page. Redirects to /login if not authenticated,
 * or to /login?error=not_allowlisted if the user is signed in but not on the
 * operator allowlist (RLS blocks profile creation in that case).
 */
export async function requireOperator(): Promise<OperatorSession> {
  if (process.env.LILA_PREVIEW_MODE === "1") {
    const { PREVIEW_SESSION } = await import("@/lib/preview");
    return PREVIEW_SESSION;
  }

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    // Try to provision from the allowlist. RLS only permits this when the
    // signed-in email is present in operator_allowlist.
    const { data: created, error } = await supabase
      .from("user_profiles")
      .insert({
        id: user.id,
        email: user.email,
        full_name: (user.user_metadata?.full_name as string | undefined) ?? null,
        notification_prefs: DEFAULT_NOTIFICATION_PREFS,
      })
      .select("*")
      .single();

    if (error || !created) {
      await supabase.auth.signOut();
      redirect("/login?error=not_allowlisted");
    }

    return { userId: user.id, email: user.email, profile: created };
  }

  if (profile.status === "disabled") {
    await supabase.auth.signOut();
    redirect("/login?error=disabled");
  }

  return { userId: user.id, email: user.email, profile };
}
