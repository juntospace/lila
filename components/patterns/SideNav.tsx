"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  ClipboardList,
  FileSpreadsheet,
  LayoutDashboard,
  PieChart,
  UserCircle2,
} from "lucide-react";

import { cn } from "@/lib/utils/cn";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/portfolio/board", label: "Portfolio board", icon: BarChart3 },
  { href: "/portfolio", label: "Portfolio snapshots", icon: PieChart },
  { href: "/recon/upload", label: "Reconciliation", icon: FileSpreadsheet },
  { href: "/recon/audit", label: "Operator audit", icon: ClipboardList },
  { href: "/profile", label: "Profile", icon: UserCircle2 },
] as const;

export function SideNav() {
  const pathname = usePathname();

  // Longest-matching href wins so `/portfolio/board` doesn't also light
  // up `/portfolio` (and vice versa).
  const activeHref = (() => {
    if (pathname === "/") return "/";
    const candidates = NAV.filter(
      (n) =>
        n.href !== "/" &&
        (pathname === n.href || pathname.startsWith(`${n.href}/`)),
    ).map((n) => n.href);
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.length >= b.length ? a : b));
  })();

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === activeHref;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded px-3 py-2 text-sm",
              active
                ? "bg-bg-raised text-fg"
                : "text-fg-muted hover:bg-bg-raised hover:text-fg",
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
