"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOperator } from "@/lib/auth/guard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const ProfileSchema = z.object({
  full_name: z
    .string()
    .trim()
    .min(2, "Name is required")
    .max(120, "Name is too long"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/u, "Use international format, e.g. +507 6123 4567")
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v)),
  language: z.enum(["en", "es"]),
  notification_prefs: z.object({
    email_application_assigned: z.boolean(),
    email_decision_required: z.boolean(),
    email_daily_digest: z.boolean(),
    whatsapp_urgent: z.boolean(),
  }),
});

export type ProfileActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Partial<Record<keyof z.infer<typeof ProfileSchema>, string>>;
};

export async function updateProfile(
  _prev: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  const session = await requireOperator();

  const parsed = ProfileSchema.safeParse({
    full_name: formData.get("full_name"),
    phone: formData.get("phone") ?? "",
    language: formData.get("language"),
    notification_prefs: {
      email_application_assigned:
        formData.get("notify_application_assigned") === "on",
      email_decision_required:
        formData.get("notify_decision_required") === "on",
      email_daily_digest: formData.get("notify_daily_digest") === "on",
      whatsapp_urgent: formData.get("notify_whatsapp_urgent") === "on",
    },
  });

  if (!parsed.success) {
    const fieldErrors: ProfileActionState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof z.infer<typeof ProfileSchema>;
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { status: "error", message: "Please fix the errors below.", fieldErrors };
  }

  if (process.env.LILA_PREVIEW_MODE === "1") {
    return { status: "success", message: "Preview mode — changes not persisted." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("user_profiles")
    .update(parsed.data)
    .eq("id", session.userId);

  if (error) {
    return { status: "error", message: "Could not save changes. Try again." };
  }

  revalidatePath("/profile");
  revalidatePath("/");
  return { status: "success", message: "Profile updated." };
}
