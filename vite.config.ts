import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'path';
import manifest from './src/manifest.json';

const CRX_PORT = 7175;

export default defineConfig(({ mode }) => {
  // @crxjs reads this env var for HMR port
  process.env.PORT = String(CRX_PORT);

  const env = loadEnv(mode, process.cwd(), '');

  // Add dev CSP rules for Vite HMR
  const baseCsp = manifest.content_security_policy.extension_pages;
  const devCsp =
    mode === 'development'
      ? baseCsp +
        ` ws://localhost:${CRX_PORT} http://localhost:${CRX_PORT} ws://localhost:* http://localhost:* ws://*:${CRX_PORT}`
      : baseCsp;

  const dynamicManifest = {
    ...manifest,
    name: env.VITE_APP_NAME || manifest.name,
    content_security_policy: {
      extension_pages: devCsp,
    },
  };

  return {
    plugins: [
      react({
        jsxRuntime: 'automatic',
        jsxImportSource: 'react',
      }),
      crx({ manifest: dynamicManifest }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@background': path.resolve(__dirname, './src/background'),
        // Shim node:crypto for browser — the extension uses SubtleCrypto directly
        'node:crypto': path.resolve(__dirname, './src/shims/crypto.ts'),
        // Stub out optional dependencies not needed in the extension
        '@sudobility/devops-components': path.resolve(
          __dirname,
          './src/shims/devops-components.ts'
        ),
        '@sudobility/subscription_lib': path.resolve(
          __dirname,
          './src/shims/subscription-lib.ts'
        ),
      },
      dedupe: ['react', 'react-dom', 'firebase/app', 'firebase/auth'],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'firebase/app',
        'firebase/auth',
      ],
    },
    server: {
      port: CRX_PORT,
      strictPort: true,
      origin: `http://localhost:${CRX_PORT}`,
      hmr: {
        protocol: 'ws',
        host: 'localhost',
        port: CRX_PORT,
        clientPort: CRX_PORT,
      },
    },
    build: {
      rollupOptions: {
        input: {
          sidepanel: path.resolve(__dirname, 'src/sidepanel/index.html'),
        },
        output: {
          manualChunks(id) {
            if (
              id.includes('react/jsx-runtime') ||
              id.includes('react/jsx-dev-runtime')
            ) {
              return 'jsx-runtime';
            }
            if (
              id.includes('node_modules/react') ||
              id.includes('node_modules/react-dom')
            ) {
              return 'react-vendor';
            }
            if (id.includes('node_modules/firebase')) {
              return 'firebase-vendor';
            }
          },
        },
      },
    },
  };
});
