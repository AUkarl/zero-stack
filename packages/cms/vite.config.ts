import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit({ preprocess: vitePreprocess(), adapter: adapter() })],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
