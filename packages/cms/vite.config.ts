import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit({ preprocess: vitePreprocess(), adapter: adapter() })],
  server: {
    proxy: {
      /** 默认还是站长的 8787；自己的台架（另起一个端口的 wrangler dev）用环境变量指过去：
          VITE_API_PROXY=http://127.0.0.1:8795 pnpm dev:cms —— 不设时行为一字不变。 */
      '/api': process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8787',
    },
  },
});
