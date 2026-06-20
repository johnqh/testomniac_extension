import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { NetworkClient } from '@sudobility/types';
import {
  TestomniacUiProvider,
  DashboardOverview,
  StartScanPage,
  TestSurfacesListPage,
  TestSurfaceDetailPage,
  TestInteractionsPage,
  TestInteractionDetailPage,
  TestRunsListPage,
  TestRunDetailPage,
  RunSurfaceRunsPage,
  RunSurfaceRunDetailPage,
  RunTestInteractionRunsPage,
  RunTestInteractionRunDetailPage,
  PagesPage,
  PageDetailPage,
  PageStateDetailPage,
  FindingsListPage,
  ScaffoldsPage,
  ScaffoldDetailPage,
  PatternsPage,
  PersonasPage,
  RunnerGraphPage,
  PageGraphPage,
  SchedulesPage,
  TestScenariosPage,
  TestScenarioDetailPage,
  ScanProgressPage,
  StatusPage,
  BundlesPage,
  BundleDetailPage,
} from '@sudobility/testomniac_ui';
import { UiRoute } from './uiAdapter';
import { DashboardLayout } from './DashboardLayout';

interface DashboardPanelProps {
  networkClient: NetworkClient;
  token: string;
  apiUrl: string;
  entitySlug: string;
}

const ui = (el: React.ReactNode) => <UiRoute>{el}</UiRoute>;

/**
 * Renders the full `@sudobility/testomniac_ui` dashboard inside the extension
 * sidepanel: an in-memory router (the extension owns routing) seeded at the
 * entity's dashboard overview, with the host network client/token injected.
 * No `SeoHead` is provided, so the library's `<SEOHead/>` renders nothing.
 */
export function DashboardPanel({
  networkClient,
  token,
  apiUrl,
  entitySlug,
}: DashboardPanelProps) {
  return (
    <TestomniacUiProvider
      networkClient={networkClient}
      token={token}
      apiUrl={apiUrl}
    >
      <MemoryRouter initialEntries={[`/en/dashboard/${entitySlug}`]}>
        <Routes>
          <Route
            path='/:lang/dashboard/:entitySlug'
            element={<DashboardLayout />}
          >
            <Route index element={ui(<DashboardOverview />)} />
            <Route path='scan/new' element={ui(<StartScanPage />)} />

            <Route
              path='environments/:envId/status'
              element={ui(<StatusPage />)}
            />
            <Route
              path='environments/:envId/bundles'
              element={ui(<BundlesPage />)}
            />
            <Route
              path='environments/:envId/bundles/:bundleId'
              element={ui(<BundleDetailPage />)}
            />
            <Route
              path='environments/:envId/test-surfaces'
              element={ui(<TestSurfacesListPage />)}
            />
            <Route
              path='environments/:envId/test-surfaces/:surfaceId'
              element={ui(<TestSurfaceDetailPage />)}
            />
            <Route
              path='environments/:envId/test-interactions'
              element={ui(<TestInteractionsPage />)}
            />
            <Route
              path='environments/:envId/test-interactions/:elementId'
              element={ui(<TestInteractionDetailPage />)}
            />
            <Route
              path='environments/:envId/runs'
              element={ui(<TestRunsListPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId'
              element={ui(<TestRunDetailPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/surface-runs'
              element={ui(<RunSurfaceRunsPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/surface-runs/:surfaceRunId'
              element={ui(<RunSurfaceRunDetailPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/surface-runs/:surfaceRunId/test-interactions/:elementId'
              element={ui(<RunTestInteractionRunsPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/surface-runs/:surfaceRunId/test-interactions/:elementId/element-runs/:elementRunId'
              element={ui(<RunTestInteractionRunDetailPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/pages'
              element={ui(<PagesPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/issues'
              element={ui(<FindingsListPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/pages/:pageId'
              element={ui(<PageDetailPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/pages/:pageId/states/:pageStateId'
              element={ui(<PageStateDetailPage />)}
            />
            <Route
              path='environments/:envId/runs/:runId/progress'
              element={ui(<ScanProgressPage />)}
            />
            <Route
              path='environments/:envId/test-scenarios'
              element={ui(<TestScenariosPage />)}
            />
            <Route
              path='environments/:envId/test-scenarios/:scenarioId'
              element={ui(<TestScenarioDetailPage />)}
            />
            <Route
              path='environments/:envId/issues'
              element={ui(<FindingsListPage />)}
            />
            <Route
              path='environments/:envId/schedules'
              element={ui(<SchedulesPage />)}
            />
            <Route
              path='environments/:envId/pages'
              element={ui(<PagesPage />)}
            />
            <Route
              path='environments/:envId/pages/:pageId'
              element={ui(<PageDetailPage />)}
            />
            <Route
              path='environments/:envId/pages/:pageId/states/:pageStateId'
              element={ui(<PageStateDetailPage />)}
            />
            <Route
              path='environments/:envId/graph'
              element={ui(<RunnerGraphPage />)}
            />
            <Route
              path='environments/:envId/pages/:pageId/graph'
              element={ui(<PageGraphPage />)}
            />
            <Route
              path='environments/:envId/scaffolds'
              element={ui(<ScaffoldsPage />)}
            />
            <Route
              path='environments/:envId/scaffolds/:scaffoldId'
              element={ui(<ScaffoldDetailPage />)}
            />
            <Route
              path='environments/:envId/patterns'
              element={ui(<PatternsPage />)}
            />
            <Route
              path='environments/:envId/personas'
              element={ui(<PersonasPage />)}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </TestomniacUiProvider>
  );
}
