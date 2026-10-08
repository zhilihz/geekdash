import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/web/', import.meta.url)),
  envDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist.candidate/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
