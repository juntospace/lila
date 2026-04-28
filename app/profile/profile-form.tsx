"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import {
  updateProfile,
  type ProfileActionState,
} from "@/app/profile/actions";
import type { NotificationPrefs, UserProfileRow } from "@/lib/supabase/types";

type Profile = UserProfileRow;

const NOTIFICATIONS: Array<{
  name: keyof NotificationPrefs;
  field: string;
  label: string;
  hint: string;
}> = [
  {
    name: "email_application_assigned",
    field: "notify_application_assigned",
    label: "New application assigned",
    hint: "Email when an application is routed to your queue.",
  },
  {
    name: "email_decision_required",
    field: "notify_decision_required",
    label: "Decision required",
    hint: "Email when an application is awaiting your approval.",
  },
  {
    name: "email_daily_digest",
    field: "notify_daily_digest",
    label: "Daily digest",
    hint: "Morning summary of your queue, decisions, and overdue loans.",
  },
  {
    name: "whatsapp_urgent",
    field: "notify_whatsapp_urgent",
    label: "WhatsApp for urgent items",
    hint: "Send a WhatsApp ping for high-severity escalations only.",
  },
];

const INITIAL: ProfileActionState = { status: "idle" };

export function ProfileForm({ profile }: { profile: Profile }) {
  const [state, formAction, isPending] = useActionState(updateProfile, INITIAL);

  return (
    <form action={formAction} className="space-y-8">
      <fieldset className="space-y-5" disabled={isPending}>
        <legend className="sr-only">Personal details</legend>

        <div className="space-y-1.5">
          <Label htmlFor="full_name">Full name</Label>
          <Input
            id="full_name"
            name="full_name"
            defaultValue={profile.full_name ?? ""}
            required
            autoComplete="name"
            aria-invalid={Boolean(state.fieldErrors?.full_name)}
            aria-describedby={state.fieldErrors?.full_name ? "full_name-error" : undefined}
          />
          {state.fieldErrors?.full_name ? (
            <p id="full_name-error" className="text-xs text-danger">
              {state.fieldErrors.full_name}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={profile.email} disabled />
          <p className="text-xs text-fg-subtle">
            Tied to your Google account. Contact an admin to change it.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            defaultValue={profile.phone ?? ""}
            placeholder="+507 6123 4567"
            autoComplete="tel"
            aria-invalid={Boolean(state.fieldErrors?.phone)}
            aria-describedby={state.fieldErrors?.phone ? "phone-error" : undefined}
          />
          {state.fieldErrors?.phone ? (
            <p id="phone-error" className="text-xs text-danger">
              {state.fieldErrors.phone}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="role">Role</Label>
          <Input id="role" value={profile.role.replace("_", " ")} disabled className="capitalize" />
          <p className="text-xs text-fg-subtle">Managed by an admin.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="language">Language</Label>
          <select
            id="language"
            name="language"
            defaultValue={profile.language}
            className="h-11 w-full rounded border border-border bg-bg-inset px-3 text-sm text-fg focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
          >
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="space-y-4" disabled={isPending}>
        <legend className="text-xs font-medium uppercase tracking-wide text-fg-muted">
          Notifications
        </legend>
        <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {NOTIFICATIONS.map((n) => (
            <div
              key={n.name}
              className="flex items-start justify-between gap-6 px-4 py-4"
            >
              <div className="min-w-0">
                <Label htmlFor={n.field} className="text-sm font-medium normal-case tracking-normal text-fg">
                  {n.label}
                </Label>
                <p className="mt-0.5 text-xs text-fg-muted">{n.hint}</p>
              </div>
              <Switch
                id={n.field}
                name={n.field}
                defaultChecked={profile.notification_prefs[n.name]}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-between gap-4"
      >
        <p
          className={
            state.status === "error"
              ? "text-sm text-danger"
              : state.status === "success"
                ? "text-sm text-success"
                : "text-sm text-fg-subtle"
          }
        >
          {state.message ?? "Changes save to your profile only."}
        </p>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
