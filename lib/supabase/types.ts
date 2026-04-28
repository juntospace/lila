import type { Database, Enums } from "@/lib/supabase/types.generated";

export type { Database } from "@/lib/supabase/types.generated";

export type OperatorRole = Enums<"operator_role">;
export type OperatorLanguage = Enums<"operator_language">;
export type OperatorStatus = Enums<"operator_status">;

/**
 * Shape contract for the `user_profiles.notification_prefs` jsonb column.
 * The DB stores it as raw json; this is the row-level invariant the app
 * reads/writes through. Add a key here, add a default below, ship a migration
 * that backfills existing rows.
 */
export type NotificationPrefs = {
  email_application_assigned: boolean;
  email_decision_required: boolean;
  email_daily_digest: boolean;
  whatsapp_urgent: boolean;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  email_application_assigned: true,
  email_decision_required: true,
  email_daily_digest: false,
  whatsapp_urgent: false,
};

/** Concrete row type with notification_prefs narrowed to NotificationPrefs. */
export type UserProfileRow = Omit<
  Database["public"]["Tables"]["user_profiles"]["Row"],
  "notification_prefs"
> & { notification_prefs: NotificationPrefs };
