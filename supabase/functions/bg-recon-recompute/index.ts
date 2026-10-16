import "@supabase/functions-js/edge-runtime.d.ts";

import { requireAuth, getAdminClient } from "../_shared/auth.ts";
import { recomputeBgAccount } from "../bg-recon/recompute.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    try {
      // 1. Authenticate Request
      await requireAuth(req);

      // 2. Parse Body
      const body = await req.json().catch(() => ({}));
      const accountId = body.account_id || body.accountId;

      if (!accountId) {
        return new Response(
          JSON.stringify({ error: "Missing required parameter 'account_id'" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // 3. Run Recompute using Admin Supabase Client inside Edge Function
      const adminSupabase = getAdminClient();
      const result = await recomputeBgAccount(adminSupabase, accountId);

      return new Response(
        JSON.stringify({ status: "ok", ...result }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (err: any) {
      console.error("bg-recon-recompute error:", err);
      const message = err?.message || String(err);
      const isAuthError =
        message.toLowerCase().includes("auth") ||
        message.toLowerCase().includes("token") ||
        message.toLowerCase().includes("unauthorized");
      const status = isAuthError ? 401 : 500;
      return new Response(
        JSON.stringify({ error: message }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  },
};
