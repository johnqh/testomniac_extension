import { type ReactNode, useMemo } from 'react';
import {
  AuthProvider,
  createDefaultErrorTexts,
} from '@sudobility/auth-components';
import type { AuthTexts } from '@sudobility/auth-components';
import {
  getFirebaseAuth,
  getFirebaseErrorMessage,
  initializeFirebaseAuth,
} from '@sudobility/auth_lib';

interface AuthProviderWrapperProps {
  children: ReactNode;
}

function createAuthTexts(): AuthTexts {
  return {
    signInTitle: 'Sign In',
    signInWithEmail: 'Sign in with email',
    createAccount: 'Create account',
    resetPassword: 'Reset password',
    signIn: 'Sign In',
    signUp: 'Sign Up',
    logout: 'Log out',
    login: 'Log in',
    continueWithGoogle: 'Continue with Google',
    continueWithApple: 'Continue with Apple',
    continueWithEmail: 'Continue with email',
    sendResetLink: 'Send reset link',
    backToSignIn: 'Back to sign in',
    close: 'Close',
    email: 'Email',
    password: 'Password',
    confirmPassword: 'Confirm password',
    displayName: 'Display name',
    emailPlaceholder: 'you@example.com',
    passwordPlaceholder: 'Enter password',
    confirmPasswordPlaceholder: 'Confirm password',
    displayNamePlaceholder: 'Your name',
    forgotPassword: 'Forgot password?',
    noAccount: "Don't have an account?",
    haveAccount: 'Already have an account?',
    or: 'or',
    resetEmailSent: 'Reset email sent',
    resetEmailSentDesc: 'Check your inbox for a password reset link.',
    passwordMismatch: 'Passwords do not match',
    passwordTooShort: 'Password must be at least 6 characters',
    loading: 'Loading...',
  };
}

/**
 * Initialises Firebase Auth and wraps children in the shared AuthProvider.
 * English-only for the extension (no i18n). Falls through gracefully
 * when Firebase is not configured.
 */
export function AuthProviderWrapper({ children }: AuthProviderWrapperProps) {
  initializeFirebaseAuth();

  const texts = useMemo(() => createAuthTexts(), []);
  const errorTexts = useMemo(() => createDefaultErrorTexts(), []);

  const auth = getFirebaseAuth();

  if (!auth) {
    console.warn(
      '[AuthProviderWrapper] No auth instance - Firebase not configured'
    );
    return <>{children}</>;
  }

  return (
    <AuthProvider
      firebaseConfig={{ type: 'instance', auth }}
      providerConfig={{
        providers: ['google', 'email'],
        enableAnonymous: false,
      }}
      texts={texts}
      errorTexts={errorTexts}
      resolveErrorMessage={getFirebaseErrorMessage}
    >
      {children}
    </AuthProvider>
  );
}
