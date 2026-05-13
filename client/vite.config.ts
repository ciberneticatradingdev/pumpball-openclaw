import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@pumpball/shared': resolve(__dirname, '../shared/types.ts'),
    },
  },
  server: {
    port: 5173,
  },
});
