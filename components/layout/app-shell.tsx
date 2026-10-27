import Link from "next/link";
import * as React from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { authProvider } from "@/lib/auth/identity";
import { APP_NAME, COPYRIGHT_NOTICE } from "@/lib/constants/brand";
import { Brand, BrandMark } from "./brand";
import { MobileNav } from "./mobile-nav";
import { SidebarNav } from "./sidebar-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  // Server-only env read; the allow-list and keys are never passed to the client.
  const accounts = authProvider() === "supabase";
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      {/* Outer column stretches with the page so the dark background never ends; inner panel stays pinned. */}
      <aside className="hidden w-64 shrink-0 bg-sidebar text-sidebar-foreground lg:block">
        <div className="sticky top-0 flex h-dvh flex-col">
          <div className="flex h-16 items-center border-b border-white/10 px-4">
            <Brand />
          </div>
          <SidebarNav />
          {accounts ? (
            <div className="border-t border-white/10 px-2 py-2 text-sidebar-muted">
              <SignOutButton className="hover:text-sidebar-foreground" />
            </div>
          ) : (
            <div className="border-t border-white/10 px-4 py-3 text-[11px] text-sidebar-muted">Local mode · no external services</div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/90 px-4 backdrop-blur lg:hidden">
          <MobileNav />
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <BrandMark className="size-6" />
            {APP_NAME}
          </Link>
          {accounts ? <SignOutButton className="ml-auto text-muted-foreground hover:text-foreground" /> : null}
        </header>

        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>

        <footer className="border-t bg-card">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
            <p>{COPYRIGHT_NOTICE}</p>
            <Link href="/copyright" className="hover:text-foreground hover:underline">
              Copyright &amp; Intellectual Property
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
