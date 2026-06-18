import { useCallback, type ReactNode } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  RoutingProvider,
  type NavigateOptions,
} from '@sudobility/testomniac_ui';
import { testomniacRoutes } from './testomniacRoutes';

/**
 * Per-route adapter that feeds the extension's MemoryRouter params + navigation
 * into the `@sudobility/testomniac_ui` routing context. The library itself has
 * no react-router dependency; this bridges it (same pattern as the web app's
 * UiRoute, but the router here is an in-memory one owned by the sidepanel).
 */
export function UiRoute({ children }: { children: ReactNode }) {
  const params = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const nav = useCallback(
    (path: string, options?: NavigateOptions) => {
      const clean = path.startsWith('/') ? path : `/${path}`;
      navigate(`/en${clean}`, options);
    },
    [navigate]
  );
  return (
    <RoutingProvider
      params={params}
      pathname={pathname}
      currentLanguage='en'
      navigate={nav}
      routes={testomniacRoutes}
    >
      {children}
    </RoutingProvider>
  );
}
