import { useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { MasterDetailLayout } from '@sudobility/components';
import { DashboardSidebar } from '@sudobility/testomniac_ui';
import { UiRoute } from './uiAdapter';

/** Sidebar + detail layout for the dashboard, mirroring the web app's DashboardPage. */
export function DashboardLayout() {
  const { entitySlug } = useParams<{ entitySlug: string }>();
  const [mobileView, setMobileView] = useState<'navigation' | 'content'>(
    'content'
  );
  return (
    <UiRoute>
      <MasterDetailLayout
        masterWidth={240}
        mobileView={mobileView}
        onBackToNavigation={() => setMobileView('navigation')}
        enableAnimations={false}
        masterContent={<DashboardSidebar entitySlug={entitySlug || ''} />}
        detailContent={<Outlet />}
      />
    </UiRoute>
  );
}
