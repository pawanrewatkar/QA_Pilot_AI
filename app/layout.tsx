import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { APP_NAME, APP_TAGLINE, COPYRIGHT_NOTICE, COPYRIGHT_OWNER } from "@/lib/constants/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: `${APP_NAME} — ${APP_TAGLINE}.`,
  applicationName: APP_NAME,
  authors: [{ name: COPYRIGHT_OWNER }],
  creator: COPYRIGHT_OWNER,
  other: { copyright: COPYRIGHT_NOTICE },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f9fb" },
    { media: "(prefers-color-scheme: dark)", color: "#14161c" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions (e.g. Katalon Recorder) add attributes to <html> before hydration.
    // This only ignores attribute differences on this element, not its children.
    <html lang="en" suppressHydrationWarning>
      {/* Browser extensions (e.g. Grammarly) add attributes to <body> before hydration. */}
      <body suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
