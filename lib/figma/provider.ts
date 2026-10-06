/**
 * Reads design data from Figma. Implemented in a later phase with the Figma REST API
 * (FIGMA_ACCESS_TOKEN). Measurements must come from the Figma file itself, never inferred.
 */
export interface FigmaProvider {
  readonly id: string;
  getFrame(ref: FigmaReference): Promise<FigmaFrame>;
}

export interface FigmaReference {
  fileKey: string;
  nodeId: string | null;
}

export interface FigmaFrame {
  fileKey: string;
  nodeId: string;
  name: string;
  width: number;
  height: number;
  nodes: FigmaNodeStyle[];
}

export interface FigmaNodeStyle {
  nodeId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontFamily?: string;
  fontSizePx?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  color?: string;
  text?: string;
}

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);

/** Parses a figma.com file/design URL into its file key and optional node id. Returns null if not a Figma URL. */
export function parseFigmaUrl(input: string): FigmaReference | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !FIGMA_HOSTS.has(url.hostname)) return null;
  const match = url.pathname.match(/^\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/|$)/);
  if (!match) return null;
  const nodeParam = url.searchParams.get("node-id");
  return { fileKey: match[1], nodeId: nodeParam ? nodeParam.replace(/-/g, ":") : null };
}

/** Aspects a future Figma comparison will cover. Values must come from the Figma file, never be inferred. */
export const FIGMA_COMPARISON_ASPECTS = ["layout", "spacing", "typography", "colors", "component-structure", "dimensions", "visual"] as const;
export type FigmaComparisonAspect = (typeof FIGMA_COMPARISON_ASPECTS)[number];

export interface FigmaComparisonItem {
  aspect: FigmaComparisonAspect;
  nodeId: string;
  property: string;
  figmaValue: string;
  observedValue: string | null;
  delta: number | null;
}

export class FigmaUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FigmaUnavailableError";
  }
}

/** Fallback used when no Figma access is configured: it has no data and says so. */
export class NotConfiguredFigmaProvider implements FigmaProvider {
  readonly id = "figma-not-configured";
  async getFrame(): Promise<FigmaFrame> {
    throw new FigmaUnavailableError("No Figma access token is configured (FIGMA_ACCESS_TOKEN), so no design data is available.");
  }
}

/** Future Figma REST API provider. Present so the architecture is in place; it is not implemented yet. */
export class RestFigmaProvider implements FigmaProvider {
  readonly id = "figma-rest";
  constructor(private readonly token: string) {}
  async getFrame(): Promise<FigmaFrame> {
    void this.token;
    throw new FigmaUnavailableError("Figma API comparison is not implemented in this version; no design values were fetched.");
  }
}

export function getFigmaProvider(env: { FIGMA_ACCESS_TOKEN?: string }): FigmaProvider {
  return env.FIGMA_ACCESS_TOKEN?.trim() ? new RestFigmaProvider(env.FIGMA_ACCESS_TOKEN.trim()) : new NotConfiguredFigmaProvider();
}
