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
    PostgrestVersion: "14.17"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          id: string
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          table_name: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
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
      portfolio_entities: {
        Row: {
          code: string
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          legal_name: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          legal_name: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          legal_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      portfolio_ingest_batches: {
        Row: {
          admin_excluded_amount: number
          admin_excluded_count: number
          cash_ahead_count: number
          created_at: string
          future_payments_excluded: number
          id: string
          missing_custom_fields: string[]
          missing_released_date_count: number
          rows_loans: number
          rows_repayments: number
          sha256_loans: string
          sha256_repayments: string | null
          snapshot_id: string
          sum_balance_ingested: number
          sum_balance_source: number
          unknown_methods: string[]
          uploaded_by: string | null
        }
        Insert: {
          admin_excluded_amount?: number
          admin_excluded_count?: number
          cash_ahead_count?: number
          created_at?: string
          future_payments_excluded?: number
          id?: string
          missing_custom_fields?: string[]
          missing_released_date_count?: number
          rows_loans?: number
          rows_repayments?: number
          sha256_loans: string
          sha256_repayments?: string | null
          snapshot_id: string
          sum_balance_ingested?: number
          sum_balance_source?: number
          unknown_methods?: string[]
          uploaded_by?: string | null
        }
        Update: {
          admin_excluded_amount?: number
          admin_excluded_count?: number
          cash_ahead_count?: number
          created_at?: string
          future_payments_excluded?: number
          id?: string
          missing_custom_fields?: string[]
          missing_released_date_count?: number
          rows_loans?: number
          rows_repayments?: number
          sha256_loans?: string
          sha256_repayments?: string | null
          snapshot_id?: string
          sum_balance_ingested?: number
          sum_balance_source?: number
          unknown_methods?: string[]
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_ingest_batches_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "portfolio_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_loan_repayments: {
        Row: {
          collection_date: string
          created_at: string
          entity_id: string
          fees_amount: number
          id: string
          ingresos_amount: number
          interest_amount: number
          is_admin: boolean
          is_real: boolean
          is_unknown_method: boolean
          method_raw: string | null
          penalty_amount: number
          principal_amount: number
          raw: Json
          snapshot_date: string
          snapshot_id: string
          source_loan_id: string
          source_repayment_id: string | null
          total_amount: number
          updated_at: string
        }
        Insert: {
          collection_date: string
          created_at?: string
          entity_id: string
          fees_amount?: number
          id?: string
          ingresos_amount?: number
          interest_amount?: number
          is_admin?: boolean
          is_real?: boolean
          is_unknown_method?: boolean
          method_raw?: string | null
          penalty_amount?: number
          principal_amount?: number
          raw?: Json
          snapshot_date: string
          snapshot_id: string
          source_loan_id: string
          source_repayment_id?: string | null
          total_amount?: number
          updated_at?: string
        }
        Update: {
          collection_date?: string
          created_at?: string
          entity_id?: string
          fees_amount?: number
          id?: string
          ingresos_amount?: number
          interest_amount?: number
          is_admin?: boolean
          is_real?: boolean
          is_unknown_method?: boolean
          method_raw?: string | null
          penalty_amount?: number
          principal_amount?: number
          raw?: Json
          snapshot_date?: string
          snapshot_id?: string
          source_loan_id?: string
          source_repayment_id?: string | null
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_loan_repayments_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "portfolio_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_loan_repayments_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "portfolio_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_loans: {
        Row: {
          balance: number
          borrower_mobile: string | null
          bucket: string
          bucket_idx: number
          cash_ahead: boolean
          combo_key: string | null
          created_at: string
          cycle_type: number | null
          dpd: number
          dpd_loandisk: number
          entity_id: string
          full_name: string | null
          gc: string | null
          id: string
          installments_count: number | null
          is_open: boolean
          last_payment_amount: number | null
          last_payment_date: string | null
          loan_duration: string | null
          loan_number: string | null
          mr: string | null
          past_due: number | null
          pending_due: number | null
          pg: string | null
          product: string | null
          raw: Json
          released_date: string | null
          repayment_cycle: string | null
          secured: boolean
          segment: string
          segment_idx: number
          snapshot_date: string
          snapshot_id: string
          source_loan_id: string
          status_raw: string | null
          tc: string | null
          tg: string | null
          total_due_amount: number | null
          updated_at: string
        }
        Insert: {
          balance?: number
          borrower_mobile?: string | null
          bucket: string
          bucket_idx?: number
          cash_ahead?: boolean
          combo_key?: string | null
          created_at?: string
          cycle_type?: number | null
          dpd?: number
          dpd_loandisk?: number
          entity_id: string
          full_name?: string | null
          gc?: string | null
          id?: string
          installments_count?: number | null
          is_open?: boolean
          last_payment_amount?: number | null
          last_payment_date?: string | null
          loan_duration?: string | null
          loan_number?: string | null
          mr?: string | null
          past_due?: number | null
          pending_due?: number | null
          pg?: string | null
          product?: string | null
          raw?: Json
          released_date?: string | null
          repayment_cycle?: string | null
          secured?: boolean
          segment: string
          segment_idx: number
          snapshot_date: string
          snapshot_id: string
          source_loan_id: string
          status_raw?: string | null
          tc?: string | null
          tg?: string | null
          total_due_amount?: number | null
          updated_at?: string
        }
        Update: {
          balance?: number
          borrower_mobile?: string | null
          bucket?: string
          bucket_idx?: number
          cash_ahead?: boolean
          combo_key?: string | null
          created_at?: string
          cycle_type?: number | null
          dpd?: number
          dpd_loandisk?: number
          entity_id?: string
          full_name?: string | null
          gc?: string | null
          id?: string
          installments_count?: number | null
          is_open?: boolean
          last_payment_amount?: number | null
          last_payment_date?: string | null
          loan_duration?: string | null
          loan_number?: string | null
          mr?: string | null
          past_due?: number | null
          pending_due?: number | null
          pg?: string | null
          product?: string | null
          raw?: Json
          released_date?: string | null
          repayment_cycle?: string | null
          secured?: boolean
          segment?: string
          segment_idx?: number
          snapshot_date?: string
          snapshot_id?: string
          source_loan_id?: string
          status_raw?: string | null
          tc?: string | null
          tg?: string | null
          total_due_amount?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_loans_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "portfolio_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_loans_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "portfolio_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_policy: {
        Row: {
          admin_methods: Json
          bucket_bins: Json
          bucket_names: Json
          co_secured_dpd: number
          co_unsecured_dpd: number
          created_at: string
          effective_from: string
          handover_date: string
          id: string
          notes: string | null
          prov_rates: Json
          real_methods: Json
          updated_at: string
          version: string
        }
        Insert: {
          admin_methods?: Json
          bucket_bins?: Json
          bucket_names?: Json
          co_secured_dpd?: number
          co_unsecured_dpd?: number
          created_at?: string
          effective_from: string
          handover_date?: string
          id?: string
          notes?: string | null
          prov_rates?: Json
          real_methods?: Json
          updated_at?: string
          version?: string
        }
        Update: {
          admin_methods?: Json
          bucket_bins?: Json
          bucket_names?: Json
          co_secured_dpd?: number
          co_unsecured_dpd?: number
          created_at?: string
          effective_from?: string
          handover_date?: string
          id?: string
          notes?: string | null
          prov_rates?: Json
          real_methods?: Json
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      portfolio_snapshots: {
        Row: {
          as_of_date: string
          cash_ahead_count: number
          cer30_balance: number
          cer30_percentage: number
          cer90_balance: number
          cer90_percentage: number
          created_at: string
          entity_id: string
          future_payments_excluded_count: number
          has_repayments: boolean
          id: string
          policy_id: string | null
          snapshot_date: string
          source_files: Json
          status: string
          total_collected_handover: number
          total_open_balance: number
          total_open_loans: number
          updated_at: string
        }
        Insert: {
          as_of_date: string
          cash_ahead_count?: number
          cer30_balance?: number
          cer30_percentage?: number
          cer90_balance?: number
          cer90_percentage?: number
          created_at?: string
          entity_id: string
          future_payments_excluded_count?: number
          has_repayments?: boolean
          id?: string
          policy_id?: string | null
          snapshot_date: string
          source_files?: Json
          status?: string
          total_collected_handover?: number
          total_open_balance?: number
          total_open_loans?: number
          updated_at?: string
        }
        Update: {
          as_of_date?: string
          cash_ahead_count?: number
          cer30_balance?: number
          cer30_percentage?: number
          cer90_balance?: number
          cer90_percentage?: number
          created_at?: string
          entity_id?: string
          future_payments_excluded_count?: number
          has_repayments?: boolean
          id?: string
          policy_id?: string | null
          snapshot_date?: string
          source_files?: Json
          status?: string
          total_collected_handover?: number
          total_open_balance?: number
          total_open_loans?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_snapshots_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "portfolio_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_snapshots_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "portfolio_policy"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_ach_batch_lines: {
        Row: {
          account_id: string
          addenda: string | null
          amount_minor: number
          batch_effective_date: string
          batch_filename: string
          beneficiary_id: string | null
          beneficiary_name: string | null
          created_at: string
          error_code: string | null
          error_description: string | null
          id: string
          observations: string | null
          routing_code: string
          row_hash: string
          target_account: string
          updated_at: string
          upload_id: string
        }
        Insert: {
          account_id: string
          addenda?: string | null
          amount_minor: number
          batch_effective_date: string
          batch_filename: string
          beneficiary_id?: string | null
          beneficiary_name?: string | null
          created_at?: string
          error_code?: string | null
          error_description?: string | null
          id?: string
          observations?: string | null
          routing_code: string
          row_hash: string
          target_account: string
          updated_at?: string
          upload_id: string
        }
        Update: {
          account_id?: string
          addenda?: string | null
          amount_minor?: number
          batch_effective_date?: string
          batch_filename?: string
          beneficiary_id?: string | null
          beneficiary_name?: string | null
          created_at?: string
          error_code?: string | null
          error_description?: string | null
          id?: string
          observations?: string | null
          routing_code?: string
          row_hash?: string
          target_account?: string
          updated_at?: string
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_ach_batch_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recon_ach_batch_lines_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "recon_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_bg_audit_alerts: {
        Row: {
          account_id: string
          created_at: string
          id: string
          message: string
          severity: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          message: string
          severity?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          message?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_bg_audit_alerts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_bg_batches: {
        Row: {
          account_id: string
          batch_date_str: string
          batch_filename: string | null
          batch_uid: string
          channel: string | null
          created_at: string
          credit_date: string | null
          credit_mov_uid: string | null
          declared_rejected_transactions: number | null
          effective_date: string | null
          fortnight: number | null
          id: string
          is_active: boolean
          is_delinquent: boolean
          itemized_succeeded_amount_minor: number | null
          pending_reason: string | null
          rejected_amount_minor: number | null
          rejected_rows_count: number | null
          retry_count: number
          reversals_mov_uids: string[]
          status: Database["public"]["Enums"]["recon_bg_batch_status_enum"]
          succeeded_amount_minor: number | null
          succeeded_rows_count: number | null
          succeeded_transactions: number | null
          total_amount_minor: number | null
          total_transactions: number | null
          updated_at: string
          upload_id: string | null
          variant: string | null
        }
        Insert: {
          account_id: string
          batch_date_str: string
          batch_filename?: string | null
          batch_uid: string
          channel?: string | null
          created_at?: string
          credit_date?: string | null
          credit_mov_uid?: string | null
          declared_rejected_transactions?: number | null
          effective_date?: string | null
          fortnight?: number | null
          id?: string
          is_active?: boolean
          is_delinquent?: boolean
          itemized_succeeded_amount_minor?: number | null
          pending_reason?: string | null
          rejected_amount_minor?: number | null
          rejected_rows_count?: number | null
          retry_count?: number
          reversals_mov_uids?: string[]
          status?: Database["public"]["Enums"]["recon_bg_batch_status_enum"]
          succeeded_amount_minor?: number | null
          succeeded_rows_count?: number | null
          succeeded_transactions?: number | null
          total_amount_minor?: number | null
          total_transactions?: number | null
          updated_at?: string
          upload_id?: string | null
          variant?: string | null
        }
        Update: {
          account_id?: string
          batch_date_str?: string
          batch_filename?: string | null
          batch_uid?: string
          channel?: string | null
          created_at?: string
          credit_date?: string | null
          credit_mov_uid?: string | null
          declared_rejected_transactions?: number | null
          effective_date?: string | null
          fortnight?: number | null
          id?: string
          is_active?: boolean
          is_delinquent?: boolean
          itemized_succeeded_amount_minor?: number | null
          pending_reason?: string | null
          rejected_amount_minor?: number | null
          rejected_rows_count?: number | null
          retry_count?: number
          reversals_mov_uids?: string[]
          status?: Database["public"]["Enums"]["recon_bg_batch_status_enum"]
          succeeded_amount_minor?: number | null
          succeeded_rows_count?: number | null
          succeeded_transactions?: number | null
          total_amount_minor?: number | null
          total_transactions?: number | null
          updated_at?: string
          upload_id?: string | null
          variant?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recon_bg_batches_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recon_bg_batches_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "recon_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_bg_coverage: {
        Row: {
          account_id: string
          coverage_date: string
          created_at: string
          id: string
          is_provisional: boolean
          is_quarantined: boolean
          source_filenames: string[]
          updated_at: string
        }
        Insert: {
          account_id: string
          coverage_date: string
          created_at?: string
          id?: string
          is_provisional?: boolean
          is_quarantined?: boolean
          source_filenames?: string[]
          updated_at?: string
        }
        Update: {
          account_id?: string
          coverage_date?: string
          created_at?: string
          id?: string
          is_provisional?: boolean
          is_quarantined?: boolean
          source_filenames?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_bg_coverage_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_bg_pending_tasks: {
        Row: {
          account_id: string
          affects_uid: string | null
          amount_minor: number | null
          created_at: string
          details: string | null
          id: string
          is_resolved: boolean
          missing_item: string
          task_type: Database["public"]["Enums"]["recon_bg_task_type_enum"]
          updated_at: string
        }
        Insert: {
          account_id: string
          affects_uid?: string | null
          amount_minor?: number | null
          created_at?: string
          details?: string | null
          id?: string
          is_resolved?: boolean
          missing_item: string
          task_type: Database["public"]["Enums"]["recon_bg_task_type_enum"]
          updated_at?: string
        }
        Update: {
          account_id?: string
          affects_uid?: string | null
          amount_minor?: number | null
          created_at?: string
          details?: string | null
          id?: string
          is_resolved?: boolean
          missing_item?: string
          task_type?: Database["public"]["Enums"]["recon_bg_task_type_enum"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_bg_pending_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_bg_yappy_batches: {
        Row: {
          account_id: string
          batch_uid: string
          created_at: string
          credit_amount_minor: number
          credit_date: string
          credit_mov_uid: string | null
          declared_count: number | null
          fee_amount_minor: number | null
          fee_rate: number | null
          id: string
          is_active: boolean
          pending_reason: string | null
          report_amount_minor: number | null
          report_count: number | null
          status: Database["public"]["Enums"]["recon_bg_batch_status_enum"]
          transaction_date: string | null
          updated_at: string
          upload_id: string | null
        }
        Insert: {
          account_id: string
          batch_uid: string
          created_at?: string
          credit_amount_minor: number
          credit_date: string
          credit_mov_uid?: string | null
          declared_count?: number | null
          fee_amount_minor?: number | null
          fee_rate?: number | null
          id?: string
          is_active?: boolean
          pending_reason?: string | null
          report_amount_minor?: number | null
          report_count?: number | null
          status?: Database["public"]["Enums"]["recon_bg_batch_status_enum"]
          transaction_date?: string | null
          updated_at?: string
          upload_id?: string | null
        }
        Update: {
          account_id?: string
          batch_uid?: string
          created_at?: string
          credit_amount_minor?: number
          credit_date?: string
          credit_mov_uid?: string | null
          declared_count?: number | null
          fee_amount_minor?: number | null
          fee_rate?: number | null
          id?: string
          is_active?: boolean
          pending_reason?: string | null
          report_amount_minor?: number | null
          report_count?: number | null
          status?: Database["public"]["Enums"]["recon_bg_batch_status_enum"]
          transaction_date?: string | null
          updated_at?: string
          upload_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recon_bg_yappy_batches_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recon_bg_yappy_batches_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "recon_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      recon_bg_yappy_lines: {
        Row: {
          account_id: string
          amount_minor: number
          bank_status: string
          client_name: string | null
          comment: string | null
          created_at: string
          id: string
          is_active: boolean
          line_uid: string
          phone_number: string | null
          posted_date: string
          posted_time: string | null
          reference: string
          settlement_batch_uid: string | null
          settlement_date: string | null
          status: Database["public"]["Enums"]["recon_bg_yappy_status_enum"]
          updated_at: string
          upload_id: string | null
        }
        Insert: {
          account_id: string
          amount_minor: number
          bank_status: string
          client_name?: string | null
          comment?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          line_uid: string
          phone_number?: string | null
          posted_date: string
          posted_time?: string | null
          reference: string
          settlement_batch_uid?: string | null
          settlement_date?: string | null
          status?: Database["public"]["Enums"]["recon_bg_yappy_status_enum"]
          updated_at?: string
          upload_id?: string | null
        }
        Update: {
          account_id?: string
          amount_minor?: number
          bank_status?: string
          client_name?: string | null
          comment?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          line_uid?: string
          phone_number?: string | null
          posted_date?: string
          posted_time?: string | null
          reference?: string
          settlement_batch_uid?: string | null
          settlement_date?: string | null
          status?: Database["public"]["Enums"]["recon_bg_yappy_status_enum"]
          updated_at?: string
          upload_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recon_bg_yappy_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recon_bg_yappy_lines_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "recon_uploads"
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
      recon_manual_assignments: {
        Row: {
          account_id: string
          assigned_at: string
          assigned_by: string | null
          category: Database["public"]["Enums"]["recon_assignment_category_enum"]
          created_at: string
          id: string
          loan_ref: string | null
          notes: string | null
          payer_name: string | null
          target_uid: string
          updated_at: string
        }
        Insert: {
          account_id: string
          assigned_at?: string
          assigned_by?: string | null
          category?: Database["public"]["Enums"]["recon_assignment_category_enum"]
          created_at?: string
          id?: string
          loan_ref?: string | null
          notes?: string | null
          payer_name?: string | null
          target_uid: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          assigned_at?: string
          assigned_by?: string | null
          category?: Database["public"]["Enums"]["recon_assignment_category_enum"]
          created_at?: string
          id?: string
          loan_ref?: string | null
          notes?: string | null
          payer_name?: string | null
          target_uid?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recon_manual_assignments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
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
          upload_id: string | null
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
          upload_id?: string | null
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
          upload_id?: string | null
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
          parsed_payload: Json | null
          parser_version: number | null
          rows_duplicate: number
          rows_new: number
          rows_total: number
          saldo_diferido_minor: number | null
          saldo_disponible_minor: number | null
          saldo_final_minor: number | null
          saldo_inicial_minor: number | null
          statement_downloaded_at: string | null
          status: Database["public"]["Enums"]["recon_uploads_status_enum"]
          storage_path: string | null
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
          parsed_payload?: Json | null
          parser_version?: number | null
          rows_duplicate?: number
          rows_new?: number
          rows_total?: number
          saldo_diferido_minor?: number | null
          saldo_disponible_minor?: number | null
          saldo_final_minor?: number | null
          saldo_inicial_minor?: number | null
          statement_downloaded_at?: string | null
          status?: Database["public"]["Enums"]["recon_uploads_status_enum"]
          storage_path?: string | null
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
          parsed_payload?: Json | null
          parser_version?: number | null
          rows_duplicate?: number
          rows_new?: number
          rows_total?: number
          saldo_diferido_minor?: number | null
          saldo_disponible_minor?: number | null
          saldo_final_minor?: number | null
          saldo_inicial_minor?: number | null
          statement_downloaded_at?: string | null
          status?: Database["public"]["Enums"]["recon_uploads_status_enum"]
          storage_path?: string | null
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
      get_portfolio_last_payment_dates: {
        Args: { p_snapshot_id: string }
        Returns: {
          last_collection_date: string
          source_loan_id: string
        }[]
      }
      get_portfolio_last_payment_map: {
        Args: { p_snapshot_id: string }
        Returns: Json
      }
      is_active_operator: { Args: never; Returns: boolean }
      is_portfolio_admin: { Args: never; Returns: boolean }
      is_portfolio_writer: { Args: never; Returns: boolean }
      is_recon_writer: { Args: never; Returns: boolean }
      portfolio_replace_snapshot: {
        Args: {
          p_batch?: Json
          p_entity_id: string
          p_loans: Json
          p_repayments: Json
          p_snapshot: Json
          p_snapshot_date: string
        }
        Returns: string
      }
      recon_bulk_update_states: {
        Args: {
          p_state: Database["public"]["Enums"]["recon_transactions_state_enum"]
          p_txn_ids: string[]
        }
        Returns: number
      }
      recon_wipe_auto_links:
        | { Args: { p_account_id: string }; Returns: number }
        | {
            Args: { p_account_id: string; p_since_date?: string }
            Returns: number
          }
    }
    Enums: {
      bank_accounts_rail_enum: "bac" | "bg"
      bank_accounts_status_enum: "active" | "archived"
      operator_language: "en" | "es"
      operator_role: "agent" | "loan_officer" | "risk_analyst" | "admin"
      operator_status: "active" | "disabled"
      recon_assignment_category_enum: "loan" | "non_loan" | "other"
      recon_bg_batch_status_enum:
        | "settled"
        | "settled_no_reversals"
        | "pending"
        | "anomaly"
      recon_bg_item_status_enum: "rejected" | "confirmed" | "pending"
      recon_bg_task_type_enum:
        | "missing_statement"
        | "missing_ach_detail"
        | "missing_yappy_report"
      recon_bg_yappy_status_enum:
        | "received"
        | "in_transit"
        | "pending"
        | "anomaly"
        | "other"
      recon_links_strategy_enum:
        | "auto_fifo_name_amount"
        | "manual"
        | "auto_batch_link"
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
      recon_uploads_method_enum:
        | "statement_excel"
        | "statement_bg_excel"
        | "ach_detail_bg_excel"
        | "yappy_bg_excel"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      bank_accounts_rail_enum: ["bac", "bg"],
      bank_accounts_status_enum: ["active", "archived"],
      operator_language: ["en", "es"],
      operator_role: ["agent", "loan_officer", "risk_analyst", "admin"],
      operator_status: ["active", "disabled"],
      recon_assignment_category_enum: ["loan", "non_loan", "other"],
      recon_bg_batch_status_enum: [
        "settled",
        "settled_no_reversals",
        "pending",
        "anomaly",
      ],
      recon_bg_item_status_enum: ["rejected", "confirmed", "pending"],
      recon_bg_task_type_enum: [
        "missing_statement",
        "missing_ach_detail",
        "missing_yappy_report",
      ],
      recon_bg_yappy_status_enum: [
        "received",
        "in_transit",
        "pending",
        "anomaly",
        "other",
      ],
      recon_links_strategy_enum: [
        "auto_fifo_name_amount",
        "manual",
        "auto_batch_link",
      ],
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
      recon_uploads_method_enum: [
        "statement_excel",
        "statement_bg_excel",
        "ach_detail_bg_excel",
        "yappy_bg_excel",
      ],
      recon_uploads_status_enum: ["parsed", "committed", "failed"],
    },
  },
} as const
