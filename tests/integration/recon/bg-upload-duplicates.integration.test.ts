// Integration test for bulk upload duplicate detection and idempotency.

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    getAll: () => [],
    get: () => undefined,
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireReconWriter: vi.fn().mockResolvedValue({
    userId: "00000000-0000-0000-0000-000000000001",
    role: "operator",
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(() =>
    createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    ),
  ),
  createSupabaseServiceClient: vi.fn(() =>
    createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    ),
  ),
}));

import { uploadStatement } from "@/app/recon/upload/actions";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe("uploadStatement duplicate detection", () => {
  const supabase = createClient(URL!, KEY!);

  it("detects existing files and returns duplicate state without corrupting metrics", async () => {
    // 1. Fetch BG account
    const { data: accounts } = await supabase
      .from("bank_accounts")
      .select("id, account_number")
      .eq("account_number", "03-43-01-106691-6");

    const account = accounts?.[0];
    expect(account).toBeDefined();
    if (!account) return;

    // 2. Fetch an existing upload file from storage
    const { data: uploads } = await supabase
      .from("recon_uploads")
      .select("id, original_filename, storage_path")
      .eq("account_id", account.id)
      .limit(1);

    const existingUpload = uploads?.[0];
    expect(existingUpload).toBeDefined();
    if (!existingUpload || !existingUpload.storage_path) return;

    const { data: blob, error: dlErr } = await supabase.storage
      .from("recon-statements")
      .download(existingUpload.storage_path);

    expect(dlErr).toBeNull();
    expect(blob).toBeDefined();
    if (!blob) return;

    const fileBytes = await blob.arrayBuffer();
    const mockFile = new File([fileBytes], existingUpload.original_filename, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    // 3. Construct FormData as if user selected this file (even alongside others)
    const formData = new FormData();
    formData.append("account_id", account.id);
    formData.append("file", mockFile);

    // 4. Call uploadStatement
    const res = await uploadStatement({ status: "idle" }, formData);

    expect(res.status).toBe("success");
    expect(res.result?.fileWasDuplicate).toBe(true);
    expect(res.result?.rowsNew).toBe(0);
    expect(res.message).toContain("already uploaded");

    // 5. Verify transaction counts for Sept 14-15 remain exactly 67 (not inflated)
    const { data: confirmed } = await supabase
      .from("recon_transactions")
      .select("id")
      .eq("account_id", account.id)
      .gte("posted_at", "2026-09-14")
      .lte("posted_at", "2026-09-15")
      .eq("state", "confirmed");

    expect(confirmed?.length).toBe(67);
  });
});
