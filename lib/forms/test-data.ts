import type { FormField } from "./analyze";

/**
 * Safe, obviously-synthetic values for form fields.
 * - Email fields only ever receive the project's configured test email (or nothing).
 * - Phone numbers use the 555-01xx range reserved for fiction.
 * - Password and file fields are never filled here.
 */
export type SafeValue = { kind: "fill"; value: string } | { kind: "check" } | { kind: "select"; value: string } | { kind: "skip"; reason: string } | { kind: "needs-email" };

export const INVALID_LOGIN_IDENTITY = "qa-pilot-invalid-user@example.invalid";

export function isEmailField(f: FormField): boolean {
  return f.type === "email" || /e-?mail/i.test(`${f.name} ${f.label} ${f.autocomplete}`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function safeValueFor(field: FormField, testEmail: string | null): SafeValue {
  const hint = `${field.name} ${field.label} ${field.autocomplete}`.toLowerCase();
  if (field.type === "password") return { kind: "skip", reason: "password fields are never filled with test data" };
  if (field.type === "file") return { kind: "skip", reason: "file upload fields are not filled automatically" };
  if (isEmailField(field)) return testEmail ? { kind: "fill", value: testEmail } : { kind: "needs-email" };
  if (field.type === "checkbox") return field.required ? { kind: "check" } : { kind: "skip", reason: "optional checkbox left unchanged" };
  if (field.type === "radio") return field.required ? { kind: "check" } : { kind: "skip", reason: "optional choice left unchanged" };
  if (field.tag === "select") {
    const value = field.options.find((o) => o !== "");
    return value !== undefined ? { kind: "select", value } : { kind: "skip", reason: "no selectable option" };
  }
  let value: string;
  if (field.type === "tel" || /phone|mobile|tel\b/.test(hint)) value = "+1 555 0100";
  else if (field.type === "url" || /website|url/.test(hint)) value = "https://example.com";
  else if (field.type === "number" || field.type === "range") value = field.min ?? "1";
  else if (field.type === "date") value = field.min ?? today();
  else if (field.type === "time") value = "12:00";
  else if (field.type === "color") value = "#336699";
  else if (/first|given/.test(hint)) value = "QA";
  else if (/last|surname|family/.test(hint)) value = "Tester";
  else if (/name/.test(hint)) value = "QA Tester";
  else if (/company|organi[sz]ation|business/.test(hint)) value = "QA Pilot Test";
  else if (/zip|postal|postcode/.test(hint)) value = "12345";
  else if (/city|town/.test(hint)) value = "Testville";
  else if (/address|street/.test(hint)) value = "1 Test Street";
  else if (/subject|title/.test(hint)) value = "QA test";
  else if (field.tag === "textarea" || /message|comment|enquiry|inquiry/.test(hint)) value = "Automated QA test message. Please ignore.";
  else value = "QA test";

  if (field.minLength && value.length < field.minLength) value = value.padEnd(field.minLength, "x");
  if (field.maxLength && value.length > field.maxLength) value = value.slice(0, field.maxLength);

  // Respect a declared pattern: pick the first safe alternative that satisfies it.
  if (field.pattern && field.patternValid) {
    const matches = compilePattern(field.pattern);
    if (matches && !matches(value)) {
      const alternative = alternativesFor(field, hint).find((candidate) => matches(candidate));
      if (alternative) value = alternative;
    }
  }
  return { kind: "fill", value };
}

function compilePattern(pattern: string): ((value: string) => boolean) | null {
  try {
    const re = new RegExp(`^(?:${pattern})$`, "v");
    return (value) => re.test(value);
  } catch {
    return null;
  }
}

function alternativesFor(field: FormField, hint: string): string[] {
  if (field.type === "tel" || /phone|mobile|tel\b/.test(hint)) return ["5550100", "555 0100", "15555550100", "1 555 555 0100", "+15555550100", "(555) 555-0100", "555-555-0100"];
  if (/zip|postal|postcode/.test(hint)) return ["12345", "10001", "SW1A 1AA", "A1A 1A1"];
  return ["QA", "QA Test", "qatest", "QATEST", "test123", "12345", "Test"];
}

export const EDGE_TEXT = {
  special: `Ünïcødé 日本語 😀 <>&"'`,
  whitespace: "   ",
  long: "QA long text ".repeat(400).trim(),
};
