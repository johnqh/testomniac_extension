import { initializeWebApp } from '@sudobility/di_web';

/**
 * Bootstrap the extension side panel by initialising the DI container
 * and Firebase before the React tree mounts. Called once from `main.tsx`.
 *
 * Mirrors testomniac_app/src/config/initialize.ts but skips i18n
 * and service worker registration (not applicable in extension context).
 */
export async function initializeApp(): Promise<void> {
  await initializeWebApp({
    firebaseConfig: {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
      measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
    },
    // Disable analytics, remote config, and messaging — not supported in Chrome extensions
    firebaseInitOptions: {
      enableAnalytics: false,
      enableRemoteConfig: false,
      enableMessaging: false,
    },
  });
}
