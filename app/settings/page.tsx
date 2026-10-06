import { Accessibility, Brain, Database, FileText, Server, Gauge, Globe, HardDrive, Layers, Mail, PenTool, ShieldCheck, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readEnv } from "@/lib/config/env";
import { getProviderStatuses, type ProviderConfigState } from "@/lib/providers/status";
import { requestDb } from "@/lib/server/db";

export const metadata: Metadata = { title: "Settings" };

const ICONS: Record<string, LucideIcon> = {
  ai: Brain,
  database: Database,
  storage: HardDrive,
  figma: PenTool,
  performance: Gauge,
  email: Mail,
  crawler: Globe,
  testing: Layers,
  accessibility: Accessibility,
  content: FileText,
};

const STATE_BADGE: Record<ProviderConfigState, { label: string; variant: "success" | "muted" | "default" }> = {
  CONFIGURED: { label: "Configured", variant: "success" },
  NOT_CONFIGURED: { label: "Not Configured", variant: "muted" },
  LOCAL: { label: "Local", variant: "default" },
};

export default async function SettingsPage() {
  const db = await requestDb();
  const health = await db.healthCheck();
  const env = readEnv();
  const providers = getProviderStatuses(env);
  const worker = await db.workers.status();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Integration and provider status. Configuration is read from server environment variables; secret values are never displayed."
      />

      <Alert variant={health.ok ? "success" : "destructive"}>
        <Database />
        <div>
          <AlertTitle>Database {health.ok ? "healthy" : "unavailable"}</AlertTitle>
          <p className="mt-1 text-muted-foreground">
            {health.detail}
            {health.schemaVersion !== null ? ` · schema version ${health.schemaVersion}` : ""}
          </p>
        </div>
      </Alert>

      <Alert variant={worker.online ? "success" : "warning"}>
        <Server />
        <div>
          <AlertTitle>Background worker {worker.online ? "online" : "offline"}</AlertTitle>
          <p className="mt-1 text-muted-foreground">
            {worker.online
              ? `Handling: ${worker.handlers.join(", ")}. Last heartbeat ${worker.lastSeenAt}.`
              : "Crawls and test runs only execute while the worker runs. Start it with npm run worker (or npm run dev:all)."}
          </p>
        </div>
      </Alert>

      <section aria-labelledby="providers-heading" className="space-y-3">
        <h2 id="providers-heading" className="text-sm font-semibold text-muted-foreground">Providers</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {providers.map((p) => {
            const Icon = ICONS[p.id] ?? Layers;
            const state = STATE_BADGE[p.state];
            return (
              <Card key={p.id}>
                <CardHeader className="flex-row items-start gap-3">
                  <div className="grid size-9 shrink-0 place-content-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle>{p.name}</CardTitle>
                      <div className="flex gap-1.5">
                        <Badge variant={state.variant}>{state.label}</Badge>
                        {p.availability === "PLANNED" ? <Badge variant="outline">Planned</Badge> : <Badge variant="success">Active</Badge>}
                      </div>
                    </div>
                    <CardDescription className="font-mono text-xs">{p.implementation}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-muted-foreground">{p.detail}</p>
                  {p.envKeys.length ? (
                    <p className="text-xs text-muted-foreground">
                      Environment: {p.envKeys.map((k) => <code key={k} className="mr-1 rounded bg-muted px-1 py-0.5">{k}</code>)}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <Card>
        <CardHeader className="flex-row items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 text-success" aria-hidden />
          <div className="space-y-1">
            <CardTitle>Data &amp; safety</CardTitle>
            <CardDescription>How QA Pilot AI treats results in this build.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>No external API is called. The only outbound traffic is the crawler and browser visiting the project website you configured.</li>
            <li>A result is only PASS, FAIL or WARNING if the check actually executed; the database enforces an execution timestamp for every verdict.</li>
            <li>Checks that cannot run are recorded as NOT EXECUTED; checks that do not apply are NOT APPLICABLE.</li>
            <li>AI analysis is advisory only and never creates results, evidence, measurements or expected content.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
