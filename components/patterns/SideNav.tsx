"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  FileSpreadsheet,
  LayoutDashboard,
  UserCircle2,
} from "lucide-react";

import { cn } from "@/lib/utils/cn";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/recon/upload", label: "Reconciliation", icon: FileSpreadsheet },
  { href: "/recon/audit", label: "Operator audit", icon: ClipboardList },
  { href: "/profile", label: "Profile", icon: UserCircle2 },
] as const;

export function SideNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
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
