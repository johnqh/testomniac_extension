import {
  GoogleAuthProvider,
  signInWithCredential,
  type Auth,
} from 'firebase/auth';

/**
 * Performs Google sign-in using chrome.identity.launchWebAuthFlow().
 *
 * signInWithPopup() does not work from Chrome extension side panels,
 * so we use Chrome's identity API to handle the OAuth flow, then
 * exchange the resulting credential with Firebase Auth.
 *
 * Setup required:
 * 1. Set VITE_GOOGLE_CLIENT_ID in .env (Firebase Console > Auth > Google > Web client ID)
 * 2. Add the extension's redirect URL to Google Cloud Console > OAuth client > Authorized redirect URIs:
 *    chrome.identity.getRedirectURL() → https://<extension-id>.chromiumapp.org/
 */
export async function chromeGoogleSignIn(auth: Auth): Promise<void> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'VITE_GOOGLE_CLIENT_ID is not configured. ' +
        'Set it in .env to the Google OAuth web client ID from Firebase Console.'
    );
  }

  const redirectUrl = chrome.identity.getRedirectURL();
  const nonce = crypto.randomUUID();

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('response_type', 'id_token token');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('prompt', 'select_account');

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  if (!responseUrl) {
    throw new Error('Google sign-in was cancelled');
  }

  // Extract tokens from the URL fragment
  const hash = new URL(responseUrl).hash.substring(1);
  const params = new URLSearchParams(hash);
  const idToken = params.get('id_token');
  const accessToken = params.get('access_token');

  if (!idToken) {
    throw new Error('No ID token received from Google');
  }

  // Create Firebase credential and sign in
  const credential = GoogleAuthProvider.credential(idToken, accessToken);
  await signInWithCredential(auth, credential);
}
