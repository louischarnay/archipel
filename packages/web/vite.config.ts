import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The server serves the built files under `/ui/`, and fills the `{{placeholders}}` of each page before sending it.
export default defineConfig({
  base: '/ui/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: ['index.html', 'setup.html', 'login.html', 'oidc-test.html'],
    },
  },
});
