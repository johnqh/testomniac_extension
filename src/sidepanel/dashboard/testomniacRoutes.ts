import type { TestomniacRoutes } from '@sudobility/testomniac_ui';

/**
 * Extension-owned URL topology for the dashboard side panel. The
 * `testomniac_ui` library never builds `/dashboard/...` paths itself — it calls
 * these builders via the routing context. Paths are app-relative (no language
 * prefix); the adapter's `navigate` prepends `/en`.
 *
 * Mirrors the web app's topology so the same library components resolve.
 */
const env = (entitySlug: string, envId: string | number) =>
  `/dashboard/${entitySlug}/environments/${envId}`;

export const testomniacRoutes: TestomniacRoutes = {
  entityHome: s => `/dashboard/${s}`,
  scanNew: s => `/dashboard/${s}/scan/new`,
  productNew: s => `/dashboard/${s}/products/new`,
  environmentNew: s => `/dashboard/${s}/environments/new`,
  entityRun: (s, runId) => `/dashboard/${s}/runs/${runId}`,

  environment: (s, e) => env(s, e),

  bundles: (s, e) => `${env(s, e)}/bundles`,
  bundle: (s, e, bundleId) => `${env(s, e)}/bundles/${bundleId}`,
  testSurfaces: (s, e) => `${env(s, e)}/test-surfaces`,
  testSurface: (s, e, surfaceId) => `${env(s, e)}/test-surfaces/${surfaceId}`,
  testInteractions: (s, e) => `${env(s, e)}/test-interactions`,
  testInteraction: (s, e, elementId) =>
    `${env(s, e)}/test-interactions/${elementId}`,
  runs: (s, e) => `${env(s, e)}/runs`,
  run: (s, e, runId) => `${env(s, e)}/runs/${runId}`,
  runSurfaceRuns: (s, e, runId) => `${env(s, e)}/runs/${runId}/surface-runs`,
  runSurfaceRun: (s, e, runId, surfaceRunId) =>
    `${env(s, e)}/runs/${runId}/surface-runs/${surfaceRunId}`,
  runSurfaceRunInteraction: (s, e, runId, surfaceRunId, elementId) =>
    `${env(s, e)}/runs/${runId}/surface-runs/${surfaceRunId}/test-interactions/${elementId}`,
  runSurfaceRunInteractionRun: (
    s,
    e,
    runId,
    surfaceRunId,
    elementId,
    elementRunId
  ) =>
    `${env(s, e)}/runs/${runId}/surface-runs/${surfaceRunId}/test-interactions/${elementId}/element-runs/${elementRunId}`,
  runPages: (s, e, runId) => `${env(s, e)}/runs/${runId}/pages`,
  runIssues: (s, e, runId) => `${env(s, e)}/runs/${runId}/issues`,
  runPage: (s, e, runId, pageId) =>
    `${env(s, e)}/runs/${runId}/pages/${pageId}`,
  runPageState: (s, e, runId, pageId, pageStateId) =>
    `${env(s, e)}/runs/${runId}/pages/${pageId}/states/${pageStateId}`,
  runProgress: (s, e, runId) => `${env(s, e)}/runs/${runId}/progress`,
  testScenarios: (s, e) => `${env(s, e)}/test-scenarios`,
  testScenario: (s, e, scenarioId) =>
    `${env(s, e)}/test-scenarios/${scenarioId}`,
  issues: (s, e) => `${env(s, e)}/issues`,
  schedules: (s, e) => `${env(s, e)}/schedules`,
  settings: (s, e) => `${env(s, e)}/settings`,
  pages: (s, e) => `${env(s, e)}/pages`,
  page: (s, e, pageId) => `${env(s, e)}/pages/${pageId}`,
  pageState: (s, e, pageId, pageStateId) =>
    `${env(s, e)}/pages/${pageId}/states/${pageStateId}`,
  graph: (s, e) => `${env(s, e)}/graph`,
  pageGraph: (s, e, pageId) => `${env(s, e)}/pages/${pageId}/graph`,
  scaffolds: (s, e) => `${env(s, e)}/scaffolds`,
  scaffold: (s, e, scaffoldId) => `${env(s, e)}/scaffolds/${scaffoldId}`,
  patterns: (s, e) => `${env(s, e)}/patterns`,
  personas: (s, e) => `${env(s, e)}/personas`,
};
