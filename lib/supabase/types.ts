// Generated types live here once `pnpm db:types` is wired up.
// Until then, hand-typed shapes for the tables we depend on.

export type Database = {
  public: {
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      operator_role: OperatorRole;
      operator_language: OperatorLanguage;
      operator_status: OperatorStatus;
    };
    CompositeTypes: Record<string, never>;
    Tables: {
      user_profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          phone: string | null;
          role: OperatorRole;
          language: OperatorLanguage;
          notification_prefs: NotificationPrefs;
          status: OperatorStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          phone?: string | null;
          role?: OperatorRole;
          language?: OperatorLanguage;
          notification_prefs?: NotificationPrefs;
          status?: OperatorStatus;
        };
        Update: Partial<{
          full_name: string | null;
          phone: string | null;
          role: OperatorRole;
          language: OperatorLanguage;
          notification_prefs: NotificationPrefs;
          status: OperatorStatus;
        }>;
        Relationships: [];
      };
      operator_allowlist: {
        Row: {
          email: string;
          role: OperatorRole;
          invited_by: string | null;
          created_at: string;
        };
        Insert: {
          email: string;
          role?: OperatorRole;
          invited_by?: string | null;
        };
        Update: Partial<{ role: OperatorRole }>;
        Relationships: [];
      };
    };
  };
};

export type OperatorRole = "agent" | "loan_officer" | "risk_analyst" | "admin";
export type OperatorLanguage = "en" | "es";
export type OperatorStatus = "active" | "disabled";

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
