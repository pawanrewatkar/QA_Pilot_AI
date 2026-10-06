import { describe, expect, it } from "vitest";
import { ALL_TEST_MODULE_IDS } from "@/lib/constants/testing";
import { parseFigmaUrl } from "@/lib/figma/provider";
import { parseProjectInput } from "@/lib/validation/project";
import { parseManualUrls, parseTestConfiguration } from "@/lib/validation/test-config";
import { isSameSite, normalizeWebsiteUrl } from "@/lib/validation/url";
import { DEFAULT_REPORT_SECTIONS } from "@/lib/constants/testing";

describe("normalizeWebsiteUrl", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["https://example.com/path?q=1#section", "https://example.com/path?q=1"],
    ["http://localhost:3000", "http://localhost:3000/"],
    ["  https://sub.example.co.uk  ", "https://sub.example.co.uk/"],
    ["http://192.168.1.10/app", "http://192.168.1.10/app"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeWebsiteUrl(input)).toEqual({ ok: true, url: expected });
  });

  it.each([
    [""],
    ["javascript:alert(1)"],
    ["ftp://example.com"],
    ["file:///etc/passwd"],
    ["https://user:pass@example.com"],
    ["https://exa mple.com"],
    ["https://nodot"],
    ["https://-bad-.com"],
    ["https://999.1.1.1"],
    [`https://example.com/${"a".repeat(2100)}`],
  ])("rejects %s", (input) => {
    expect(normalizeWebsiteUrl(input).ok).toBe(false);
  });

  it("matches same site including www and subdomains, not lookalikes", () => {
    expect(isSameSite("https://www.example.com", "https://example.com/a")).toBe(true);
    expect(isSameSite("https://example.com", "https://shop.example.com/")).toBe(true);
    expect(isSameSite("https://example.com", "https://notexample.com/")).toBe(false);
    expect(isSameSite("https://example.com", "https://example.com.evil.io/")).toBe(false);
  });
});

describe("parseFigmaUrl", () => {
  it("extracts file key and node id", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123/My-File?node-id=12-34")).toEqual({ fileKey: "AbC123", nodeId: "12:34" });
    expect(parseFigmaUrl("https://figma.com/file/XYZ/Name")).toEqual({ fileKey: "XYZ", nodeId: null });
  });
  it("rejects non-Figma URLs", () => {
    expect(parseFigmaUrl("https://evil.com/design/AbC123")).toBeNull();
    expect(parseFigmaUrl("http://www.figma.com/design/AbC123")).toBeNull();
    expect(parseFigmaUrl("not a url")).toBeNull();
  });
});

describe("parseProjectInput", () => {
  it("normalizes valid input and turns blanks into null", () => {
    const result = parseProjectInput({ name: "  Shop  ", websiteUrl: "shop.example.com", description: "", figmaUrl: "", testEmail: "" });
    expect(result).toEqual({
      ok: true,
      data: { name: "Shop", websiteUrl: "https://shop.example.com/", description: null, figmaUrl: null, testEmail: null },
    });
  });

  it("reports a message per invalid field", () => {
    const result = parseProjectInput({ name: "", websiteUrl: "ftp://x.com", figmaUrl: "https://example.com", testEmail: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["figmaUrl", "name", "testEmail", "websiteUrl"]);
  });
});

describe("test configuration validation", () => {
  const project = { id: "p1", websiteUrl: "https://example.com/" };
  const base = {
    name: "Smoke",
    scope: "ENTIRE_WEBSITE",
    selectedPageIds: [],
    manualUrls: "",
    modules: ["links", "seo"],
    browsers: ["chromium"],
    viewports: ["desktop-1920x1080"],
    reportFormats: ["PDF"],
    reportSections: DEFAULT_REPORT_SECTIONS,
  };

  it("accepts a valid configuration and canonicalizes ordering", () => {
    const result = parseTestConfiguration({ ...base, modules: ["seo", "links", "seo"], browsers: ["webkit", "chromium"] }, project, new Set());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.modules).toEqual(["links", "seo"]);
    expect(result.data.browsers).toEqual(["chromium", "webkit"]);
  });

  it("supports Select All (every module)", () => {
    const result = parseTestConfiguration({ ...base, modules: ALL_TEST_MODULE_IDS }, project, new Set());
    expect(result.ok && result.data.modules.length).toBe(33);
  });

  it("requires modules, browsers and viewports", () => {
    const result = parseTestConfiguration({ ...base, modules: [], browsers: [], viewports: [] }, project, new Set());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveProperty("modules");
    expect(result.errors).toHaveProperty("browsers");
    expect(result.errors).toHaveProperty("viewports");
  });

  it("rejects unknown modules and viewports", () => {
    expect(parseTestConfiguration({ ...base, modules: ["hack"] }, project, new Set()).ok).toBe(false);
    expect(parseTestConfiguration({ ...base, viewports: ["800x600"] }, project, new Set()).ok).toBe(false);
  });

  it("manual URLs must be valid and on the project site", () => {
    const { urls, errors } = parseManualUrls("https://example.com/a\nexample.com/a\nhttps://other.com/\nftp://example.com", project.websiteUrl);
    expect(urls).toEqual(["https://example.com/a"]);
    expect(errors).toHaveLength(2);
    expect(parseTestConfiguration({ ...base, scope: "MANUAL_URLS", manualUrls: "" }, project, new Set()).ok).toBe(false);
  });

  it("selected pages must exist for the project", () => {
    expect(parseTestConfiguration({ ...base, scope: "SELECTED_PAGES", selectedPageIds: ["x"] }, project, new Set()).ok).toBe(false);
    expect(parseTestConfiguration({ ...base, scope: "SELECTED_PAGES", selectedPageIds: ["x"] }, project, new Set(["x"])).ok).toBe(true);
  });
});
