import { getTestModule } from "@/lib/constants/testing";
import type { ScenarioType } from "@/types";
import type { TestModule } from "./context";
import { accordionModule, carouselModule, dropdownsModule, modalsModule, tabsModule } from "./modules/components";
import { downloadsModule } from "./modules/downloads";
import { formsModule, loginModule, logoutModule, newsletterModule } from "./modules/forms";
import { linksModule, socialLinksModule } from "./modules/links";
import { navigationModule } from "./modules/navigation";
import { consoleModule, networkModule, unimplementedModule } from "./modules/observability";
import { breadcrumbModule, filtersModule, functionalModule, paginationModule } from "./modules/page-features";
import { searchModule } from "./modules/search";
import { accessibilityModule } from "./modules/accessibility";
import { contentModule } from "./modules/content";
import { ecommerceModule } from "./modules/ecommerce";
import { figmaModule } from "./modules/figma";
import { responsiveModule, uiModule } from "./modules/layout-modules";
import { performanceModule } from "./modules/performance";
import { seoModule } from "./modules/seo";
import { typographyModule } from "./modules/typography";

/** Modules with a real implementation in this build, in execution order. */
export const IMPLEMENTED_MODULES: TestModule[] = [
  // Measurement-only modules observe the freshly loaded page before interactive modules change its state.
  consoleModule,
  networkModule,
  uiModule,
  typographyModule,
  accessibilityModule,
  seoModule,
  contentModule,
  linksModule,
  socialLinksModule,
  downloadsModule,
  navigationModule,
  functionalModule,
  dropdownsModule,
  tabsModule,
  accordionModule,
  modalsModule,
  carouselModule,
  searchModule,
  filtersModule,
  paginationModule,
  breadcrumbModule,
  formsModule,
  newsletterModule,
  loginModule,
  logoutModule,
  // Modules that resize the window, change the cart or launch a separate browser run last.
  responsiveModule,
  ecommerceModule,
  figmaModule,
  performanceModule,
];

/** Scenario-type modules select cases by scenario across feature modules instead of running on their own. */
export const SCENARIO_MODULES: Record<string, ScenarioType> = {
  positive: "POSITIVE",
  negative: "NEGATIVE",
  edge: "EDGE",
  boundary: "BOUNDARY",
};

/** Feature modules that produce positive / negative / edge / boundary cases. */
const SCENARIO_PRODUCERS: Record<string, ScenarioType[]> = {
  navigation: ["POSITIVE"],
  dropdowns: ["POSITIVE"],
  search: ["POSITIVE", "NEGATIVE", "EDGE", "BOUNDARY"],
  filters: ["POSITIVE"],
  pagination: ["POSITIVE"],
  breadcrumb: ["POSITIVE"],
  forms: ["POSITIVE", "NEGATIVE", "EDGE", "BOUNDARY"],
  newsletter: ["POSITIVE", "NEGATIVE"],
  login: ["POSITIVE", "NEGATIVE"],
};

export const IMPLEMENTED_MODULE_IDS = new Set(IMPLEMENTED_MODULES.map((m) => m.id));

export interface ExecutionPlan {
  modules: TestModule[];
  /** Keeps a case if its module was selected, or its scenario type was selected through a scenario module. */
  keep(moduleId: string, scenarioType: ScenarioType): boolean;
}

/**
 * Resolves the user's module selection into what actually runs:
 * - selected implemented modules run;
 * - scenario modules (positive/negative/edge/boundary) pull in the feature modules that produce those scenarios;
 * - selected modules without an implementation yet report NOT EXECUTED.
 */
export function planExecution(selected: string[]): ExecutionPlan {
  const chosen = new Set(selected);
  const scenarios = new Set(selected.filter((id) => id in SCENARIO_MODULES).map((id) => SCENARIO_MODULES[id]));
  const modules: TestModule[] = [];
  for (const m of IMPLEMENTED_MODULES) {
    const viaScenario = (SCENARIO_PRODUCERS[m.id] ?? []).some((s) => scenarios.has(s));
    if (chosen.has(m.id) || viaScenario) modules.push(m);
  }
  for (const id of selected) {
    if (IMPLEMENTED_MODULE_IDS.has(id) || id in SCENARIO_MODULES) continue;
    modules.push(unimplementedModule(id, getTestModule(id)?.label ?? id));
  }
  return {
    modules,
    keep(moduleId, scenarioType) {
      if (chosen.has(moduleId)) return true;
      return scenarioType !== "FUNCTIONAL" && scenarios.has(scenarioType);
    },
  };
}
