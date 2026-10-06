import { readEnv } from "@/lib/config/env";
import { FIGMA_COMPARISON_ASPECTS, FigmaUnavailableError, getFigmaProvider, parseFigmaUrl, type FigmaProvider } from "@/lib/figma/provider";
import type { TestModule } from "../context";
import { outcome } from "../outcome";
import { spec } from "./helpers";

/**
 * Figma comparison. Until a provider can supply real design data, every comparison is
 * NOT EXECUTED with the reason; design values are never invented.
 */
export function createFigmaModule(provider: FigmaProvider = getFigmaProvider(readEnv())): TestModule {
  return {
    id: "figma",
    scope: "page",
    async run(ctx) {
      const s = spec("figma", "comparison", {
        title: "Page matches the Figma design",
        section: "Design",
        feature: "Figma comparison",
        element: ctx.project.figmaUrl ?? "no Figma URL",
        steps: ["Load the Figma frame for this page", `Compare ${FIGMA_COMPARISON_ASPECTS.join(", ")}`],
        expected: "Rendered layout, spacing, typography, colours, structure and dimensions match the design",
        expectationSource: "FIGMA",
      });
      if (!ctx.project.figmaUrl) return [outcome.notExecuted(s, "The project has no Figma URL, so there is no design to compare against.")];
      const ref = parseFigmaUrl(ctx.project.figmaUrl);
      if (!ref) return [outcome.notExecuted(s, `The project's Figma URL is not a recognisable figma.com file link: ${ctx.project.figmaUrl}`)];
      try {
        await provider.getFrame(ref);
      } catch (error) {
        return [outcome.notExecuted(s, error instanceof FigmaUnavailableError ? error.reason : `Figma data could not be loaded: ${error instanceof Error ? error.message : String(error)}`)];
      }
      // Reached only once a provider returns real frame data; the comparison itself is a later phase.
      return [outcome.notExecuted(s, "Figma data was loaded, but automated design comparison is not implemented in this version.")];
    },
  };
}

export const figmaModule = createFigmaModule();
