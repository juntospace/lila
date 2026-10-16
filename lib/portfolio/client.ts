import { isPreviewMode } from "@/lib/preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Returns the authenticated Supabase client for portfolio routes.
 * Always enforces RLS via createSupabaseServerClient() (never service role).
 * Fails closed in production if LILA_PREVIEW_MODE=1 is accidentally set.
 */
export async function getPortfolioClient() {
  if (
    isPreviewMode() &&
    (process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production")
  ) {
    throw new Error(
      "Security violation: LILA_PREVIEW_MODE cannot be enabled in production.",
    );
  }
  return await createSupabaseServerClient();
}

