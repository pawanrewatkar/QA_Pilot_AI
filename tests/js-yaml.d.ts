// Minimal types for js-yaml (present through ESLint's dependencies; used only by tests/worker-workflow.test.ts).
declare module "js-yaml" {
  const yaml: { load(text: string): unknown };
  export default yaml;
}
