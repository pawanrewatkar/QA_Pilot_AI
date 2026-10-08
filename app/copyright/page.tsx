import type { Metadata } from "next";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { APP_NAME, COPYRIGHT_NOTICE, COPYRIGHT_OWNER } from "@/lib/constants/brand";

export const metadata: Metadata = {
  title: "Copyright & Intellectual Property",
  description: `Copyright and intellectual property policy for ${APP_NAME}.`,
};

const PROTECTED_MATERIALS = [
  "Text",
  "Images",
  "Graphics",
  "Videos",
  "Source code",
  "Software architecture, where legally protectable",
  "Branding",
  "Logos",
  "Icons",
  "UI design",
  "Visual design",
  "Layouts",
  "Reports",
  "Templates",
  "Documentation",
  "Original testing workflows",
  "Other original materials",
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function CopyrightPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Copyright & Intellectual Property" description={`How original materials in ${APP_NAME} are protected, and what this policy does not restrict.`} />

      <Card>
        <CardContent className="space-y-8 pt-5">
          <Section id="ownership" title="Ownership">
            <p>
              {APP_NAME} and its original materials are created and owned by {COPYRIGHT_OWNER}. {COPYRIGHT_NOTICE}
            </p>
          </Section>

          <Section id="materials" title="Original materials">
            <p>Original materials in {APP_NAME} may include:</p>
            <ul className="grid grid-cols-1 list-disc gap-x-8 gap-y-1 pl-5 sm:grid-cols-2">
              {PROTECTED_MATERIALS.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Section>

          <Section id="restrictions" title="Permitted and restricted use">
            <p>
              Subject to applicable law and third-party rights, these materials may not be copied, reproduced, redistributed, republished,
              modified, adapted, reverse-engineered where prohibited by law, commercially reused, resold, repackaged, or presented as someone
              else&apos;s work without permission.
            </p>
            <p className="font-medium text-foreground">
              Nothing in this policy is intended to limit rights that cannot lawfully be restricted under applicable law.
            </p>
          </Section>

          <Section id="scope" title="What copyright covers">
            <p>
              Copyright protects original expression and materials. It does not automatically provide exclusive ownership over general ideas,
              concepts, methods, functionality, or general QA practices unless another applicable legal protection applies.
            </p>
          </Section>

          <Section id="third-party" title="Third-party materials">
            <p>
              Third-party libraries, open-source packages, trademarks, APIs, icons, fonts, images, and services used by {APP_NAME} remain subject
              to their respective licenses and rights. Their inclusion does not transfer any ownership to {COPYRIGHT_OWNER}, and nothing here
              overrides the terms of those licenses.
            </p>
          </Section>

          <Section id="measures" title="How materials are protected">
            <p>
              {APP_NAME} relies on reasonable, non-intrusive measures: copyright notices, branding, document metadata, report branding where
              appropriate, keeping business logic on the server, and keeping secrets and configuration private.
            </p>
            <p>
              It deliberately does not disable right-click, copy and paste, text selection or keyboard shortcuts, and it does not block screen
              readers, accessibility tools or legitimate search-engine crawlers.
            </p>
          </Section>

          <Section id="permissions" title="Permissions">
            <p>To request permission to use any original material beyond what applicable law allows, contact {COPYRIGHT_OWNER}.</p>
          </Section>

          <p className="border-t pt-5 text-sm font-medium">{COPYRIGHT_NOTICE}</p>
        </CardContent>
      </Card>
    </div>
  );
}
