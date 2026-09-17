import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node 20+ provides Web Crypto and fetch globally, which is what the Edge
    // Function code uses - so those modules can be tested here directly rather
    // than only inside Deno.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
  },
});
