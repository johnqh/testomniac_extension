import { useEffect, useState } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import { getFirebaseAuth } from '@sudobility/auth_lib';

/**
 * Syncs the Firebase ID token to chrome.storage.session and the
 * background service worker via chrome.runtime.sendMessage.
 *
 * - Listens to `onIdTokenChanged` for automatic token refresh (~every hour)
 * - On sign-out, clears the stored token
 * - On side panel mount, re-syncs the current token
 *
 * Returns the current token string (or null if not authenticated).
 */
export function useAuthTokenSync(): string | null {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!auth) return;

    const unsubscribe = onIdTokenChanged(auth, async user => {
      if (user) {
        const idToken = await user.getIdToken();
        setToken(idToken);
        chrome.storage.session.set({ firebaseToken: idToken });
        chrome.runtime
          .sendMessage({ type: 'SET_AUTH_TOKEN', token: idToken })
          .catch(() => {});
      } else {
        setToken(null);
        chrome.storage.session.remove('firebaseToken');
        chrome.runtime
          .sendMessage({ type: 'SET_AUTH_TOKEN', token: null })
          .catch(() => {});
      }
    });

    return () => unsubscribe();
  }, []);

  return token;
}
