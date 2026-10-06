import {
  Bug,
  CirclePlay,
  Copyright,
  FileChartColumn,
  FileText,
  FolderKanban,
  History,
  LayoutDashboard,
  ListChecks,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/test-runs", label: "Test Runs", icon: CirclePlay },
      { href: "/pages", label: "Pages", icon: FileText },
      { href: "/test-cases", label: "Test Cases", icon: ListChecks },
      { href: "/bugs", label: "Bugs", icon: Bug },
      { href: "/reports", label: "Reports", icon: FileChartColumn },
      { href: "/history", label: "History", icon: History },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/copyright", label: "Copyright & IP", icon: Copyright },
    ],
  },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
