import Link from "next/link";
import { APP_NAME } from "@/lib/constants/brand";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--sidebar-active)" />
      <path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} className="flex items-center gap-2.5 rounded-md px-1 text-white">
      <BrandMark className="size-8" />
      <span className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
        <span className="text-[11px] text-sidebar-muted">QA automation platform</span>
      </span>
    </Link>
  );
}
