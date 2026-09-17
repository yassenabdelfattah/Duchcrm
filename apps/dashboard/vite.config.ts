import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Staff use the sale screen on their phones over the shop wifi, so the dev
    // server has to be reachable from something other than localhost.
    host: true,
  },
  build: {
    sourcemap: true,
  },
});
