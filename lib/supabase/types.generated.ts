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
      portfolio_borrowers: {
        Row: {
          address: string | null
          age: number | null
          borrower_status_raw: string | null
          business: string | null
          cedula_normalized: string | null
          city: string | null
          country: string | null
          created_at: string
          created_date: string | null
          credit_score: number | null
          currency: string
          date_of_birth: string | null
          email: string | null
          entity_id: string
          first_name: string | null
          full_name: string | null
          gender: string | null
          id: string
          landline: string | null
          last_name: string | null
          loan_officer_raw: string | null
          mobile: string | null
          normalized_name: string | null
          number_of_defaulted_loans: number | null
          number_of_denied_loans: number | null
          number_of_fully_paid_loans: number | null
          number_of_loans: number | null
          number_of_not_taken_up_loans: number | null
          number_of_open_loans: number | null
          number_of_processing_loans: number | null
          number_of_restructured_loans: number | null
          open_loans_balance_minor: number | null
          province: string | null
          raw: Json
          snapshot_date: string
          snapshot_id: string
          source_borrower_id: string
          total_paid_amount_minor: number | null
          unique_number: string | null
          updated_at: string
          working_status: string | null
          zipcode: string | null
        }
        Insert: {
          address?: string | null
          age?: number | null
          borrower_status_raw?: string | null
          business?: string | null
          cedula_normalized?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          created_date?: string | null
          credit_score?: number | null
          currency?: string
          date_of_birth?: string | null
          email?: string | null
          entity_id: string
          first_name?: string | null
          full_name?: string | null
          gender?: string | null
          id?: string
          landline?: string | null
          last_name?: string | null
          loan_officer_raw?: string | null
          mobile?: string | null
          normalized_name?: string | null
          number_of_defaulted_loans?: number | null
          number_of_denied_loans?: number | null
          number_of_fully_paid_loans?: number | null
          number_of_loans?: number | null
          number_of_not_taken_up_loans?: number | null
          number_of_open_loans?: number | null
          number_of_processing_loans?: number | null
          number_of_restructured_loans?: number | null
          open_loans_balance_minor?: number | null
          province?: string | null
          raw?: Json
          snapshot_date: string
          snapshot_id: string
          source_borrower_id: string
          total_paid_amount_minor?: number | null
          unique_number?: string | null
          updated_at?: string
          working_status?: string | null
          zipcode?: string | null
        }
        Update: {
          address?: string | null
          age?: number | null
          borrower_status_raw?: string | null
          business?: string | null
          cedula_normalized?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          created_date?: string | null
          credit_score?: number | null
          currency?: string
          date_of_birth?: string | null
          email?: string | null
          entity_id?: string
          first_name?: string | null
          full_name?: string | null
          gender?: string | null
          id?: string
          landline?: string | null
          last_name?: string | null
          loan_officer_raw?: string | null
          mobile?: string | null
          normalized_name?: string | null
          number_of_defaulted_loans?: number | null
          number_of_denied_loans?: number | null
          number_of_fully_paid_loans?: number | null
          number_of_loans?: number | null
          number_of_not_taken_up_loans?: number | null
          number_of_open_loans?: number | null
          number_of_processing_loans?: number | null
          number_of_restructured_loans?: number | null
          open_loans_balance_minor?: number | null
          province?: string | null
          raw?: Json
          snapshot_date?: string
          snapshot_id?: string
          source_borrower_id?: string
          total_paid_amount_minor?: number | null
          unique_number?: string | null
          updated_at?: string
          working_status?: string | null
          zipcode?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_borrowers_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "portfolio_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_borrowers_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "portfolio_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_entities: {
        Row: {
          code: Database["public"]["Enums"]["portfolio_entities_code_enum"]
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          legal_name: string
          updated_at: string
        }
        Insert: {
          code: Database["public"]["Enums"]["portfolio_entities_code_enum"]
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          legal_name: string
          updated_at?: string
        }
        Update: {
          code?: Database["public"]["Enums"]["portfolio_entities_code_enum"]
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          legal_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      portfolio_loan_repayments: {
        Row: {
          approved_by: string | null
          bank_account_payment_raw: string | null
          collected_by: string | null
          collection_date: string | null
          created_at: string
          currency: string
          description: string | null
          edit_date: string | null
          entity_id: string
          fees_paid_minor: number
          id: string
          interest_paid_minor: number
          is_cash_collection: boolean
          loan_officer_raw: string | null
          method: string | null
          penalty_paid_minor: number
          principal_paid_minor: number
          raw: Json
          snapshot_date: string
          snapshot_id: string
          source_borrower_ref: string | null
          source_loan_id: string
          source_repayment_id: string
          total_paid_minor: number
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          bank_account_payment_raw?: string | null
          collected_by?: string | null
          collection_date?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          edit_date?: string | null
          entity_id: string
          fees_paid_minor?: number
          id?: string
          interest_paid_minor?: number
          is_cash_collection?: boolean
          loan_officer_raw?: string | null
          method?: string | null
          penalty_paid_minor?: number
          principal_paid_minor?: number
          raw?: Json
          snapshot_date: string
          snapshot_id: string
          source_borrower_ref?: string | null
          source_loan_id: string
          source_repayment_id: string
          total_paid_minor?: number
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          bank_account_payment_raw?: string | null
          collected_by?: string | null
          collection_date?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          edit_date?: string | null
          entity_id?: string
          fees_paid_minor?: number
          id?: string
          interest_paid_minor?: number
          is_cash_collection?: boolean
          loan_officer_raw?: string | null
          method?: string | null
          penalty_paid_minor?: number
          principal_paid_minor?: number
          raw?: Json
          snapshot_date?: string
          snapshot_id?: string
          source_borrower_ref?: string | null
          source_loan_id?: string
          source_repayment_id?: string
          total_paid_minor?: number
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
          balance_amount_minor: number | null
          bank_account_loan_released: string | null
          borrower_join_confidence: Database["public"]["Enums"]["portfolio_loans_borrower_join_enum"]
          created_at: string
          currency: string
          days_past_due: number | null
          days_past_maturity: number | null
          days_to_maturity: number | null
          duration_months: number | null
          entity_id: string
          id: string
          ifrs_stage:
            | Database["public"]["Enums"]["portfolio_loans_ifrs_stage_enum"]
            | null
          interest_rate_raw: string | null
          is_npl: boolean | null
          last_payment_amount_minor: number | null
          last_payment_date: string | null
          loan_officer_raw: string | null
          management_vintage:
            | Database["public"]["Enums"]["portfolio_loans_management_vintage_enum"]
            | null
          maturity_date: string | null
          next_installment_amount_minor: number | null
          next_installment_date: string | null
          paid_amount_minor: number | null
          past_due_minor: number | null
          pending_due_minor: number | null
          pending_principal_due_minor: number | null
          portfolio_segment:
            | Database["public"]["Enums"]["portfolio_loans_portfolio_segment_enum"]
            | null
          principal_amount_minor: number | null
          product_group: Database["public"]["Enums"]["portfolio_loans_product_group_enum"]
          product_raw: string | null
          raw: Json
          released_date: string | null
          repayment_cycle: string | null
          resolved_source_borrower_id: string | null
          snapshot_date: string
          snapshot_id: string
          source_borrower_ref: string | null
          source_loan_id: string
          source_loan_number: string | null
          status_normalized:
            | Database["public"]["Enums"]["portfolio_loans_status_enum"]
            | null
          status_raw: string | null
          total_fees_balance_minor: number | null
          total_fees_paid_minor: number | null
          total_interest_balance_minor: number | null
          total_interest_paid_minor: number | null
          total_penalty_balance_minor: number | null
          total_penalty_paid_minor: number | null
          total_principal_balance_minor: number | null
          total_principal_paid_minor: number | null
          updated_at: string
        }
        Insert: {
          balance_amount_minor?: number | null
          bank_account_loan_released?: string | null
          borrower_join_confidence?: Database["public"]["Enums"]["portfolio_loans_borrower_join_enum"]
          created_at?: string
          currency?: string
          days_past_due?: number | null
          days_past_maturity?: number | null
          days_to_maturity?: number | null
          duration_months?: number | null
          entity_id: string
          id?: string
          ifrs_stage?:
            | Database["public"]["Enums"]["portfolio_loans_ifrs_stage_enum"]
            | null
          interest_rate_raw?: string | null
          is_npl?: boolean | null
          last_payment_amount_minor?: number | null
          last_payment_date?: string | null
          loan_officer_raw?: string | null
          management_vintage?:
            | Database["public"]["Enums"]["portfolio_loans_management_vintage_enum"]
            | null
          maturity_date?: string | null
          next_installment_amount_minor?: number | null
          next_installment_date?: string | null
          paid_amount_minor?: number | null
          past_due_minor?: number | null
          pending_due_minor?: number | null
          pending_principal_due_minor?: number | null
          portfolio_segment?:
            | Database["public"]["Enums"]["portfolio_loans_portfolio_segment_enum"]
            | null
          principal_amount_minor?: number | null
          product_group?: Database["public"]["Enums"]["portfolio_loans_product_group_enum"]
          product_raw?: string | null
          raw?: Json
          released_date?: string | null
          repayment_cycle?: string | null
          resolved_source_borrower_id?: string | null
          snapshot_date: string
          snapshot_id: string
          source_borrower_ref?: string | null
          source_loan_id: string
          source_loan_number?: string | null
          status_normalized?:
            | Database["public"]["Enums"]["portfolio_loans_status_enum"]
            | null
          status_raw?: string | null
          total_fees_balance_minor?: number | null
          total_fees_paid_minor?: number | null
          total_interest_balance_minor?: number | null
          total_interest_paid_minor?: number | null
          total_penalty_balance_minor?: number | null
          total_penalty_paid_minor?: number | null
          total_principal_balance_minor?: number | null
          total_principal_paid_minor?: number | null
          updated_at?: string
        }
        Update: {
          balance_amount_minor?: number | null
          bank_account_loan_released?: string | null
          borrower_join_confidence?: Database["public"]["Enums"]["portfolio_loans_borrower_join_enum"]
          created_at?: string
          currency?: string
          days_past_due?: number | null
          days_past_maturity?: number | null
          days_to_maturity?: number | null
          duration_months?: number | null
          entity_id?: string
          id?: string
          ifrs_stage?:
            | Database["public"]["Enums"]["portfolio_loans_ifrs_stage_enum"]
            | null
          interest_rate_raw?: string | null
          is_npl?: boolean | null
          last_payment_amount_minor?: number | null
          last_payment_date?: string | null
          loan_officer_raw?: string | null
          management_vintage?:
            | Database["public"]["Enums"]["portfolio_loans_management_vintage_enum"]
            | null
          maturity_date?: string | null
          next_installment_amount_minor?: number | null
          next_installment_date?: string | null
          paid_amount_minor?: number | null
          past_due_minor?: number | null
          pending_due_minor?: number | null
          pending_principal_due_minor?: number | null
          portfolio_segment?:
            | Database["public"]["Enums"]["portfolio_loans_portfolio_segment_enum"]
            | null
          principal_amount_minor?: number | null
          product_group?: Database["public"]["Enums"]["portfolio_loans_product_group_enum"]
          product_raw?: string | null
          raw?: Json
          released_date?: string | null
          repayment_cycle?: string | null
          resolved_source_borrower_id?: string | null
          snapshot_date?: string
          snapshot_id?: string
          source_borrower_ref?: string | null
          source_loan_id?: string
          source_loan_number?: string | null
          status_normalized?:
            | Database["public"]["Enums"]["portfolio_loans_status_enum"]
            | null
          status_raw?: string | null
          total_fees_balance_minor?: number | null
          total_fees_paid_minor?: number | null
          total_interest_balance_minor?: number | null
          total_interest_paid_minor?: number | null
          total_penalty_balance_minor?: number | null
          total_penalty_paid_minor?: number | null
          total_principal_balance_minor?: number | null
          total_principal_paid_minor?: number | null
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
          cash_advance_always_new: boolean
          charge_off_dpd_threshold: number
          created_at: string
          ecl_stage_1_coverage: number | null
          ecl_stage_2_coverage: number | null
          ecl_stage_3_coverage: number | null
          effective_from: string
          id: string
          management_cutoff_date: string
          notes: string | null
          npl_dpd_min: number
          stage_2_dpd_min: number
          stage_3_dpd_min: number
          updated_at: string
        }
        Insert: {
          cash_advance_always_new?: boolean
          charge_off_dpd_threshold?: number
          created_at?: string
          ecl_stage_1_coverage?: number | null
          ecl_stage_2_coverage?: number | null
          ecl_stage_3_coverage?: number | null
          effective_from: string
          id?: string
          management_cutoff_date?: string
          notes?: string | null
          npl_dpd_min?: number
          stage_2_dpd_min?: number
          stage_3_dpd_min?: number
          updated_at?: string
        }
        Update: {
          cash_advance_always_new?: boolean
          charge_off_dpd_threshold?: number
          created_at?: string
          ecl_stage_1_coverage?: number | null
          ecl_stage_2_coverage?: number | null
          ecl_stage_3_coverage?: number | null
          effective_from?: string
          id?: string
          management_cutoff_date?: string
          notes?: string | null
          npl_dpd_min?: number
          stage_2_dpd_min?: number
          stage_3_dpd_min?: number
          updated_at?: string
        }
        Relationships: []
      }
      portfolio_snapshot_dq: {
        Row: {
          created_at: string
          detail: Json
          id: string
          metric: string
          severity: Database["public"]["Enums"]["portfolio_snapshot_dq_severity_enum"]
          snapshot_id: string
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: string
          metric: string
          severity?: Database["public"]["Enums"]["portfolio_snapshot_dq_severity_enum"]
          snapshot_id: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: string
          metric?: string
          severity?: Database["public"]["Enums"]["portfolio_snapshot_dq_severity_enum"]
          snapshot_id?: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_snapshot_dq_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "portfolio_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_snapshots: {
        Row: {
          borrower_row_count: number
          created_at: string
          entity_id: string
          error_message: string | null
          finalized_at: string | null
          id: string
          imported_at: string
          imported_by: string | null
          loan_row_count: number
          loans_with_borrower_match: number
          loans_without_borrower_match: number
          policy_id: string
          repayment_row_count: number
          snapshot_date: string
          source_files: Json
          status: Database["public"]["Enums"]["portfolio_snapshots_status_enum"]
          updated_at: string
        }
        Insert: {
          borrower_row_count?: number
          created_at?: string
          entity_id: string
          error_message?: string | null
          finalized_at?: string | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          loan_row_count?: number
          loans_with_borrower_match?: number
          loans_without_borrower_match?: number
          policy_id: string
          repayment_row_count?: number
          snapshot_date: string
          source_files?: Json
          status?: Database["public"]["Enums"]["portfolio_snapshots_status_enum"]
          updated_at?: string
        }
        Update: {
          borrower_row_count?: number
          created_at?: string
          entity_id?: string
          error_message?: string | null
          finalized_at?: string | null
          id?: string
          imported_at?: string
          imported_by?: string | null
          loan_row_count?: number
          loans_with_borrower_match?: number
          loans_without_borrower_match?: number
          policy_id?: string
          repayment_row_count?: number
          snapshot_date?: string
          source_files?: Json
          status?: Database["public"]["Enums"]["portfolio_snapshots_status_enum"]
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
      portfolio_loan_metric_facts: {
        Row: {
          balance_amount_minor: number | null
          cash_collected_minor: number | null
          cash_count: number | null
          cohort_month: string | null
          days_past_due: number | null
          entity_id: string | null
          finiquito_count: number | null
          ifrs_stage:
            | Database["public"]["Enums"]["portfolio_loans_ifrs_stage_enum"]
            | null
          is_npl: boolean | null
          loan_officer_raw: string | null
          loan_pk: string | null
          management_vintage:
            | Database["public"]["Enums"]["portfolio_loans_management_vintage_enum"]
            | null
          maturity_date: string | null
          paid_amount_minor: number | null
          past_due_minor: number | null
          portfolio_segment:
            | Database["public"]["Enums"]["portfolio_loans_portfolio_segment_enum"]
            | null
          principal_amount_minor: number | null
          product_group:
            | Database["public"]["Enums"]["portfolio_loans_product_group_enum"]
            | null
          released_date: string | null
          resolved_source_borrower_id: string | null
          snapshot_date: string | null
          snapshot_id: string | null
          source_borrower_ref: string | null
          source_loan_id: string | null
          status_normalized:
            | Database["public"]["Enums"]["portfolio_loans_status_enum"]
            | null
          write_off_minor: number | null
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
    }
    Functions: {
      is_active_operator: { Args: never; Returns: boolean }
      is_portfolio_writer: { Args: never; Returns: boolean }
      is_recon_writer: { Args: never; Returns: boolean }
    }
    Enums: {
      bank_accounts_rail_enum: "bac" | "bg"
      bank_accounts_status_enum: "active" | "archived"
      operator_language: "en" | "es"
      operator_role: "agent" | "loan_officer" | "risk_analyst" | "admin"
      operator_status: "active" | "disabled"
      portfolio_entities_code_enum: "crediclaro" | "junto_soluciones"
      portfolio_loans_borrower_join_enum:
        | "exact_unique_number"
        | "normalized_name"
        | "unresolved"
      portfolio_loans_ifrs_stage_enum:
        | "stage_1"
        | "stage_2"
        | "stage_3"
        | "closed"
      portfolio_loans_management_vintage_enum: "old" | "new"
      portfolio_loans_portfolio_segment_enum:
        | "old_personal"
        | "new_personal"
        | "cash_advance"
        | "other"
      portfolio_loans_product_group_enum:
        | "personal_collateralized"
        | "personal_uncollateralized"
        | "cash_advance"
        | "other"
      portfolio_loans_status_enum:
        | "closed"
        | "performing"
        | "delinquent"
        | "legacy_delinquent"
      portfolio_snapshot_dq_severity_enum: "ok" | "warn" | "critical"
      portfolio_snapshots_status_enum: "in_progress" | "completed" | "failed"
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
      portfolio_entities_code_enum: ["crediclaro", "junto_soluciones"],
      portfolio_loans_borrower_join_enum: [
        "exact_unique_number",
        "normalized_name",
        "unresolved",
      ],
      portfolio_loans_ifrs_stage_enum: [
        "stage_1",
        "stage_2",
        "stage_3",
        "closed",
      ],
      portfolio_loans_management_vintage_enum: ["old", "new"],
      portfolio_loans_portfolio_segment_enum: [
        "old_personal",
        "new_personal",
        "cash_advance",
        "other",
      ],
      portfolio_loans_product_group_enum: [
        "personal_collateralized",
        "personal_uncollateralized",
        "cash_advance",
        "other",
      ],
      portfolio_loans_status_enum: [
        "closed",
        "performing",
        "delinquent",
        "legacy_delinquent",
      ],
      portfolio_snapshot_dq_severity_enum: ["ok", "warn", "critical"],
      portfolio_snapshots_status_enum: ["in_progress", "completed", "failed"],
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
      ],
      recon_uploads_status_enum: ["parsed", "committed", "failed"],
    },
  },
} as const
