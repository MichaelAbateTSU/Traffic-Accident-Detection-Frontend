import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { validateProductionBuild } from './src/config.js';

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  if (command === 'build') {
    validateProductionBuild(env);
  }
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
    server: {
      port: 3000,
      // Proxy API calls to the backend during development
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
