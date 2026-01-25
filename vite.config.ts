import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'path';
import manifest from './src/manifest.json';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Add dev CSP rules for Vite HMR
  const baseCsp = manifest.content_security_policy.extension_pages;
  const devCsp = mode === 'development'
    ? baseCsp + ' ws://localhost:* http://localhost:*'
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
        '@shared': path.resolve(__dirname, './src/shared'),
        '@background': path.resolve(__dirname, './src/background'),
        '@popup': path.resolve(__dirname, './src/popup'),
      },
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ],
    },
    build: {
      rollupOptions: {
        input: {
          popup: path.resolve(__dirname, 'src/popup/index.html'),
        },
        output: {
          manualChunks(id) {
            if (id.includes('react/jsx-runtime') || id.includes('react/jsx-dev-runtime')) {
              return 'jsx-runtime';
            }
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
              return 'react-vendor';
            }
          },
        },
      },
    },
  };
});
