import { getAdminClient } from "./auth.ts";

export async function computeFileSha256(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadToStorage(
  storagePath: string,
  fileBytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const adminSupabase = getAdminClient();
  const { error } = await adminSupabase.storage
    .from("recon-statements")
    .upload(storagePath, fileBytes, {
      contentType: contentType || "application/octet-stream",
      upsert: true,
    });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }
}

export async function removeFromStorage(storagePath: string): Promise<void> {
  try {
    const adminSupabase = getAdminClient();
    await adminSupabase.storage.from("recon-statements").remove([storagePath]);
  } catch {
    // Silent rollback on error
  }
}

