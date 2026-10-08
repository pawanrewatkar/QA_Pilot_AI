import { LocalAnalysisProvider } from "./local-analysis-provider";
import type { AIProvider } from "./provider";

export type { AIProvider } from "./provider";

let instance: AIProvider | null = null;

/**
 * Returns the active analysis provider. Only the local, deterministic provider exists in
 * this version; an LLM-backed provider can be added here behind AI_PROVIDER without changing callers.
 */
export function getAIProvider(): AIProvider {
  instance ??= new LocalAnalysisProvider();
  return instance;
}
