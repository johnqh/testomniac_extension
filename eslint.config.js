import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  // Base configuration for all files
  js.configs.recommended,

  // Prettier configuration to disable conflicting rules
  prettierConfig,

  // Configuration for TypeScript files
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        NodeJS: 'readonly',

        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        performance: 'readonly',
        requestIdleCallback: 'readonly',
        self: 'readonly',
        define: 'readonly',

        // DOM/HTML globals
        HTMLElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLImageElement: 'readonly',
        HTMLLabelElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLLinkElement: 'readonly',
        HTMLScriptElement: 'readonly',
        HTMLAudioElement: 'readonly',
        HTMLVideoElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLMediaElement: 'readonly',
        InputEvent: 'readonly',
        Event: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        PointerEvent: 'readonly',
        TouchEvent: 'readonly',
        DragEvent: 'readonly',
        ClipboardEvent: 'readonly',
        FileReader: 'readonly',
        File: 'readonly',
        Blob: 'readonly',

        // React globals
        React: 'readonly',
        JSX: 'readonly',

        // Encoding/Crypto globals
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',

        // Chrome Extension globals
        chrome: 'readonly',
        XMLHttpRequest: 'readonly',
        RequestInfo: 'readonly',
        RequestInit: 'readonly',
        Request: 'readonly',

        // Web APIs
        IntersectionObserver: 'readonly',
        PerformanceObserver: 'readonly',
        PerformanceEntry: 'readonly',
        PerformanceResourceTiming: 'readonly',
        PerformanceNavigationTiming: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        requestAnimationFrame: 'readonly',
        location: 'readonly',
        Image: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      prettier: prettier,
    },
    rules: {
      // Disable base rule and enable TypeScript version
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
      'prefer-const': 'error',
      'no-constant-binary-expression': 'off', // Allow constant expressions in tests

      // React Hooks rules - disable overly strict v7 rules
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off', // Allow setState in effects for DOM measurements
      'react-hooks/purity': 'off', // Allow performance.now() and other impure functions when needed
      'react-hooks/static-components': 'off', // Allow components created during render for flexibility
      'react-hooks/refs': 'off', // Allow ref access patterns for performance optimization

      // React Refresh rules - more permissive for utility files
      'react-refresh/only-export-components': 'off',

      // Prettier rules
      'prettier/prettier': 'error',
    },
  },

  // Configuration for test files
  {
    files: ['**/__tests__/**/*', '**/*.test.*', '**/*.spec.*'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
        test: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },

  // Ignore patterns
  {
    ignores: ['dist/**', '**/*.example.*', 'node_modules/**', 'vendor/**'],
  },
];
