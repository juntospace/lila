import Link from "next/link";

import { SideNav } from "@/components/patterns/SideNav";
import { SignOutButton } from "@/components/patterns/SignOutButton";
import type { OperatorSession } from "@/lib/auth/guard";

export function OperatorShell({
  session,
  children,
}: {
  session: OperatorSession;
  children: React.ReactNode;
}) {
  const initials = (session.profile.full_name ?? session.email)
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-border-subtle bg-bg-surface lg:flex lg:flex-col">
        <div className="flex h-16 items-center px-6">
          <Link href="/" className="font-display text-xl font-semibold tracking-tight">
            LILA
          </Link>
        </div>
        <SideNav />
        <div className="border-t border-border-subtle p-3">
          <Link
            href="/profile"
            className="flex items-center gap-3 rounded px-3 py-2 text-sm text-fg hover:bg-bg-raised"
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-500/15 text-xs font-semibold text-brand-300">
              {initials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {session.profile.full_name ?? session.email.split("@")[0]}
              </span>
              <span className="block truncate text-xs text-fg-subtle capitalize">
                {session.profile.role.replace("_", " ")}
              </span>
            </span>
          </Link>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border-subtle bg-bg-surface/60 px-6 backdrop-blur lg:px-10">
          <div className="lg:hidden">
            <Link href="/" className="font-display text-lg font-semibold">
              LILA
            </Link>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-fg-muted sm:inline">
              {session.email}
            </span>
            <SignOutButton />
          </div>
        </header>
        <main className="flex-1 px-6 py-8 lg:px-10 lg:py-10">{children}</main>
      </div>
    </div>
  );
}
