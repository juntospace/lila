export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bank_accounts: {
        Row: {
          account_number: string
          created_at: string
          currency: string
          holder_name: string
          id: string
          rail: Database["public"]["Enums"]["bank_accounts_rail_enum"]
          status: Database["public"]["Enums"]["bank_accounts_status_enum"]
          updated_at: string
        }
        Insert: {
          account_number: string
          created_at?: string
          currency?: string
          holder_name: string
          id?: string
          rail: Database["public"]["Enums"]["bank_accounts_rail_enum"]
          status?: Database["public"]["Enums"]["bank_accounts_status_enum"]
          updated_at?: string
        }
        Update: {
          account_number?: string
          created_at?: string
          currency?: string
          holder_name?: string
          id?: string
          rail?: Database["public"]["Enums"]["bank_accounts_rail_enum"]
          status?: Database["public"]["Enums"]["bank_accounts_status_enum"]
          updated_at?: string
        }
        Relationships: []
      }
      name_aliases: {
        Row: {
          account_id: string
          created_at: string
          created_by: string | null
          da_name_normalized: string
          id: string
          pr_name_normalized: string
          rail: Database["public"]["Enums"]["bank_accounts_rail_enum"]
        }
        Insert: {
          account_id: string
          created_at?: string
          created_by?: string | null
          da_name_normalized: string
          id?: string
          pr_name_normalized: string
          rail: Database["public"]["Enums"]["bank_accounts_rail_enum"]
        }
        Update: {
          account_id?: string
          created_at?: string
          created_by?: string | null
          da_name_normalized?: string
          id?: string
          pr_name_normalized?: string
          rail?: Database["public"]["Enums"]["bank_accounts_rail_enum"]
        }
        Relationships: [
          {
            foreignKeyName: "name_aliases_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_allowlist: {
        Row: {
          created_at: string
          email: string
          invited_by: string | null
          role: Database["public"]["Enums"]["operator_role"]
        }
        Insert: {
          created_at?: string
          email: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["operator_role"]
        }
        Update: {
          created_at?: string
          email?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["operator_role"]
        }
        Relationships: []
      }
      recon_ach_batch_lines: {
        Row: {
          id: string
          upload_id: string
          account_id: string
          batch_filename: string
          batch_effective_date: string
          routing_code: string
          target_account: string
          amount_minor: number
          beneficiary_id: string | null
          beneficiary_name: string | null
          addenda: string | null
          error_code: string | null
          error_description: string | null
          observations: string | null
          row_hash: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          upload_id: string
          account_id: string
          batch_filename: string
          batch_effective_date: string
          routing_code: string
          target_account: string
          amount_minor: number | string
          beneficiary_id?: string | null
          beneficiary_name?: string | null
          addenda?: string | null
          error_code?: string | null
          error_description?: string | null
          observations?: string | null
          row_hash: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          upload_id?: string
          account_id?: string
          batch_filename?: string
          batch_effective_date?: string
          routing_code?: string
          target_account?: string
          amount_minor?: number | string
          beneficiary_id?: string | null
          beneficiary_name?: string | null
          addenda?: string | null
          error_code?: string | null
          error_description?: string | null
          observations?: string | null
          row_hash?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_ach_batch_lines_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "recon_uploads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recon_ach_batch_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_links: {
        Row: {
          da_txn_id: string
          match_strategy: Database["public"]["Enums"]["recon_links_strategy_enum"]
          matched_at: string
          matched_by: string | null
          pr_txn_id: string
        }
        Insert: {
          da_txn_id: string
          match_strategy: Database["public"]["Enums"]["recon_links_strategy_enum"]
          matched_at?: string
          matched_by?: string | null
          pr_txn_id: string
        }
        Update: {
          da_txn_id?: string
          match_strategy?: Database["public"]["Enums"]["recon_links_strategy_enum"]
          matched_at?: string
          matched_by?: string | null
          pr_txn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_links_da_txn_id_fkey"
            columns: ["da_txn_id"]
            isOneToOne: true
            referencedRelation: "recon_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recon_links_pr_txn_id_fkey"
            columns: ["pr_txn_id"]
            isOneToOne: true
            referencedRelation: "recon_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_manual_actions: {
        Row: {
          acted_at: string
          acted_by: string | null
          action: Database["public"]["Enums"]["recon_manual_actions_action_enum"]
          id: string
          justification: string
          new_kind:
            | Database["public"]["Enums"]["recon_transactions_kind_enum"]
            | null
          new_state:
            | Database["public"]["Enums"]["recon_transactions_state_enum"]
            | null
          prior_kind:
            | Database["public"]["Enums"]["recon_transactions_kind_enum"]
            | null
          prior_state:
            | Database["public"]["Enums"]["recon_transactions_state_enum"]
            | null
          txn_id: string
        }
        Insert: {
          acted_at?: string
          acted_by?: string | null
          action: Database["public"]["Enums"]["recon_manual_actions_action_enum"]
          id?: string
          justification: string
          new_kind?:
            | Database["public"]["Enums"]["recon_transactions_kind_enum"]
            | null
          new_state?:
            | Database["public"]["Enums"]["recon_transactions_state_enum"]
            | null
          prior_kind?:
            | Database["public"]["Enums"]["recon_transactions_kind_enum"]
            | null
          prior_state?:
            | Database["public"]["Enums"]["recon_transactions_state_enum"]
            | null
          txn_id: string
        }
        Update: {
          acted_at?: string
          acted_by?: string | null
          action?: Database["public"]["Enums"]["recon_manual_actions_action_enum"]
          id?: string
          justification?: string
          new_kind?:
            | Database["public"]["Enums"]["recon_transactions_kind_enum"]
            | null
          new_state?:
            | Database["public"]["Enums"]["recon_transactions_state_enum"]
            | null
          prior_kind?:
            | Database["public"]["Enums"]["recon_transactions_kind_enum"]
            | null
          prior_state?:
            | Database["public"]["Enums"]["recon_transactions_state_enum"]
            | null
          txn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_manual_actions_txn_id_fkey"
            columns: ["txn_id"]
            isOneToOne: false
            referencedRelation: "recon_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_transactions: {
        Row: {
          account_id: string
          balance_minor: number | null
          code: string
          confirmable_after: string | null
          created_at: string
          credit_minor: number
          currency: string
          debit_minor: number
          description: string | null
          id: string
          kind: Database["public"]["Enums"]["recon_transactions_kind_enum"]
          payer_name_raw: string | null
          posted_at: string
          rail_native_ref: string | null
          return_code: string | null
          row_hash: string
          state: Database["public"]["Enums"]["recon_transactions_state_enum"]
          updated_at: string
          upload_id: string
        }
        Insert: {
          account_id: string
          balance_minor?: number | null
          code: string
          confirmable_after?: string | null
          created_at?: string
          credit_minor?: number
          currency: string
          debit_minor?: number
          description?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["recon_transactions_kind_enum"]
          payer_name_raw?: string | null
          posted_at: string
          rail_native_ref?: string | null
          return_code?: string | null
          row_hash: string
          state?: Database["public"]["Enums"]["recon_transactions_state_enum"]
          updated_at?: string
          upload_id: string
        }
        Update: {
          account_id?: string
          balance_minor?: number | null
          code?: string
          confirmable_after?: string | null
          created_at?: string
          credit_minor?: number
          currency?: string
          debit_minor?: number
          description?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["recon_transactions_kind_enum"]
          payer_name_raw?: string | null
          posted_at?: string
          rail_native_ref?: string | null
          return_code?: string | null
          row_hash?: string
          state?: Database["public"]["Enums"]["recon_transactions_state_enum"]
          updated_at?: string
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recon_transactions_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "recon_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_uploads: {
        Row: {
          account_id: string
          created_at: string
          date_range_end: string | null
          date_range_start: string | null
          error_message: string | null
          file_sha256: string
          id: string
          integrity_ok: boolean | null
          method: Database["public"]["Enums"]["recon_uploads_method_enum"]
          original_filename: string | null
          rows_duplicate: number
          rows_new: number
          rows_total: number
          saldo_final_minor: number | null
          saldo_inicial_minor: number | null
          status: Database["public"]["Enums"]["recon_uploads_status_enum"]
          updated_at: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          date_range_end?: string | null
          date_range_start?: string | null
          error_message?: string | null
          file_sha256: string
          id?: string
          integrity_ok?: boolean | null
          method: Database["public"]["Enums"]["recon_uploads_method_enum"]
          original_filename?: string | null
          rows_duplicate?: number
          rows_new?: number
          rows_total?: number
          saldo_final_minor?: number | null
          saldo_inicial_minor?: number | null
          status?: Database["public"]["Enums"]["recon_uploads_status_enum"]
          updated_at?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          date_range_end?: string | null
          date_range_start?: string | null
          error_message?: string | null
          file_sha256?: string
          id?: string
          integrity_ok?: boolean | null
          method?: Database["public"]["Enums"]["recon_uploads_method_enum"]
          original_filename?: string | null
          rows_duplicate?: number
          rows_new?: number
          rows_total?: number
          saldo_final_minor?: number | null
          saldo_inicial_minor?: number | null
          status?: Database["public"]["Enums"]["recon_uploads_status_enum"]
          updated_at?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recon_uploads_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          language: Database["public"]["Enums"]["operator_language"]
          notification_prefs: Json
          phone: string | null
          role: Database["public"]["Enums"]["operator_role"]
          status: Database["public"]["Enums"]["operator_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          language?: Database["public"]["Enums"]["operator_language"]
          notification_prefs?: Json
          phone?: string | null
          role?: Database["public"]["Enums"]["operator_role"]
          status?: Database["public"]["Enums"]["operator_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          language?: Database["public"]["Enums"]["operator_language"]
          notification_prefs?: Json
          phone?: string | null
          role?: Database["public"]["Enums"]["operator_role"]
          status?: Database["public"]["Enums"]["operator_status"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_active_operator: { Args: never; Returns: boolean }
      is_recon_writer: { Args: never; Returns: boolean }
    }
    Enums: {
      bank_accounts_rail_enum: "bac" | "bg"
      bank_accounts_status_enum: "active" | "archived"
      operator_language: "en" | "es"
      operator_role: "agent" | "loan_officer" | "risk_analyst" | "admin"
      operator_status: "active" | "disabled"
      recon_links_strategy_enum:
        | "auto_fifo_name_amount"
        | "auto_batch_link"
        | "manual"
      recon_manual_actions_action_enum:
        | "force_confirm"
        | "force_reject"
        | "reclassify"
      recon_transactions_kind_enum:
        | "loan_inflow"
        | "reversal"
        | "non_loan"
        | "unknown"
      recon_transactions_state_enum:
        | "pending"
        | "confirmed"
        | "rejected"
        | "non_loan"
        | "pending_pair"
      recon_uploads_method_enum: "statement_excel" | "statement_bg_excel" | "ach_detail_bg_excel"
      recon_uploads_status_enum: "parsed" | "committed" | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      bank_accounts_rail_enum: ["bac", "bg"],
      bank_accounts_status_enum: ["active", "archived"],
      operator_language: ["en", "es"],
      operator_role: ["agent", "loan_officer", "risk_analyst", "admin"],
      operator_status: ["active", "disabled"],
      recon_links_strategy_enum: ["auto_fifo_name_amount", "auto_batch_link", "manual"],
      recon_manual_actions_action_enum: [
        "force_confirm",
        "force_reject",
        "reclassify",
      ],
      recon_transactions_kind_enum: [
        "loan_inflow",
        "reversal",
        "non_loan",
        "unknown",
      ],
      recon_transactions_state_enum: [
        "pending",
        "confirmed",
        "rejected",
        "non_loan",
        "pending_pair",
      ],
      recon_uploads_method_enum: ["statement_excel", "statement_bg_excel", "ach_detail_bg_excel"],
      recon_uploads_status_enum: ["parsed", "committed", "failed"],
    },
  },
} as const
