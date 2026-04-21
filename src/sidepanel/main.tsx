import React from 'react';
import ReactDOM from 'react-dom/client';
import { SidePanel } from './SidePanel';
import { AuthProviderWrapper } from './components/AuthProviderWrapper';
import { initializeApp } from './config/initialize';
import './index.css';

initializeApp().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AuthProviderWrapper>
        <SidePanel />
      </AuthProviderWrapper>
    </React.StrictMode>
  );
});
