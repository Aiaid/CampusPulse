import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': new URL('./tests/helpers/cloudflare-workers.ts', import.meta.url).pathname } },
  test: {
    include: ['tests/**/*.test.{ts,js}'],
  },
});
