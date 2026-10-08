import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./src/web/', import.meta.url)),
  envDir: false,
  build: {
    rollupOptions: {
      input: ['index.html', 'project-detail.html'].map(path => fileURLToPath(new URL(`./src/web/${path}`, import.meta.url))),
    },
    outDir: fileURLToPath(new URL('./dist.candidate/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
