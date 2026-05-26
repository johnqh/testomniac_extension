import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidePanel } from './SidePanel';
import { AuthProviderWrapper } from './components/AuthProviderWrapper';
import { initializeApp } from './config/initialize';
import './index.css';

const queryClient = new QueryClient();

initializeApp().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProviderWrapper>
          <SidePanel />
        </AuthProviderWrapper>
      </QueryClientProvider>
    </React.StrictMode>
  );
});
