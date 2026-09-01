import { redirect } from "next/navigation";

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
  type UserProfileRow,
} from "@/lib/supabase/types";

export type OperatorSession = {
  userId: string;
  email: string;
  profile: UserProfileRow;
};

function narrowPrefs(value: unknown): NotificationPrefs {
  // Defensive: if a row predates a key, fall back to the current default.
  const v = (value ?? {}) as Partial<NotificationPrefs>;
  return { ...DEFAULT_NOTIFICATION_PREFS, ...v };
}

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

  const adminDb = createSupabaseServiceClient();

  let { data: profile } = await adminDb
    .from("user_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    // Check if the user is present in operator_allowlist
    const { data: allowEntry } = await adminDb
      .from("operator_allowlist")
      .select("role")
      .ilike("email", user.email)
      .maybeSingle();

    if (!allowEntry) {
      await supabase.auth.signOut();
      redirect("/login?error=not_allowlisted");
    }

    const { data: created, error } = await adminDb
      .from("user_profiles")
      .insert({
        id: user.id,
        email: user.email,
        full_name: (user.user_metadata?.full_name as string | undefined) ?? null,
        role: allowEntry.role,
        notification_prefs: DEFAULT_NOTIFICATION_PREFS,
      })
      .select("*")
      .single();

    if (error || !created) {
      await supabase.auth.signOut();
      redirect("/login?error=not_allowlisted");
    }

    profile = created;
  }

  if (profile.status === "disabled") {
    await supabase.auth.signOut();
    redirect("/login?error=disabled");
  }

  return {
    userId: user.id,
    email: user.email,
    profile: { ...profile, notification_prefs: narrowPrefs(profile.notification_prefs) },
  };
}

/**
 * Guard for routes that need recon-writer privileges (creating bank
 * accounts, uploading statements, posting manual reconciliation actions).
 * Mirrors the `is_recon_writer()` SECURITY DEFINER function used in RLS.
 */
export async function requireReconWriter(): Promise<OperatorSession> {
  const session = await requireOperator();
  const role = session.profile.role;
  if (role !== "loan_officer" && role !== "admin") {
    redirect("/?error=insufficient_role");
  }
  return session;
}
