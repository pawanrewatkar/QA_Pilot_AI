/** Extracts page URLs and nested sitemap URLs from a sitemap or sitemap index document. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const decode = (s: string) =>
    s
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();

  const blockRe = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of xml.matchAll(blockRe)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(match[2]);
    if (!loc) continue;
    const value = decode(loc[1]);
    if (!value) continue;
    (match[1].toLowerCase() === "sitemap" ? sitemaps : urls).push(value);
  }
  return { urls, sitemaps };
}
