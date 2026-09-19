import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Vite looks for .env next to this config by default, which would mean a
  // second env file inside apps/dashboard. There is one .env, at the root of
  // the repository, alongside the .env.example it is copied from.
  // Relative to this config's directory, so it resolves to the repo root.
  envDir: '../..',
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
