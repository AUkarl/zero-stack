import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte({ compilerOptions: { customElement: true } })],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['umd'],
      name: 'ZeroComment',
      fileName: () => 'zero-comment.js',
    },
    cssCodeSplit: false,
    minify: true,
  },
});
