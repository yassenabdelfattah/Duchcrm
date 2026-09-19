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
    // Supabase is proxied through this same server in development, so a phone
    // (or a tunnel) only needs one reachable port instead of two. Without it
    // the page comes from :5173 and the API from :54321, and anything that
    // blocks the second one - a firewall, a router isolating devices, a tunnel
    // that forwards a single port - leaves a dashboard that renders and then
    // fails every request.
    proxy: {
      '/supabase': {
        target: 'http://127.0.0.1:54321',
        changeOrigin: true,
        // Realtime runs over a websocket, which the packing queue depends on.
        ws: true,
        rewrite: (path) => path.replace(/^\/supabase/, ''),
      },
    },
  },
  build: {
    sourcemap: true,
  },
});
