<script lang="ts">
  import { renderMarkdown } from '../lib/markdown';

  let { text = '', shortBase = '/post/' }: { text?: string; shortBase?: string } = $props();

  // 内容里的原始 HTML 会先被转义，只剩 Markdown 子集被渲染成标签，
  // 所以这里可以安全地 {@html}。
  const html = $derived(renderMarkdown(text, { shortBase }));

  let box = $state<HTMLDivElement | undefined>();

  /**
   * {@html} 生成不了 Svelte 事件，图片表情的 onerror 只能事后补：
   * 裂图换成 token 原文（[weibo:smile]），CDN 挂了也不会留一个破碎图标。
   */
  const bound = new WeakSet<HTMLImageElement>();

  function demote(img: HTMLImageElement) {
    img.replaceWith(document.createTextNode(img.dataset.emoji || img.alt || ''));
  }

  $effect(() => {
    const el = box;
    if (!el) return;
    void html;
    for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img.zc-emoji-img'))) {
      if (bound.has(img)) continue;
      bound.add(img);
      img.addEventListener('error', () => demote(img), { once: true });
      // 监听挂上时就已经失败（缓存里的 404）不会再来 error 事件，这里当场补一次
      if (img.complete && img.naturalWidth === 0) demote(img);
    }
  });
</script>

<div class="md" bind:this={box}>{@html html}</div>

<style>
  /* 兜底值一律用中性色/inherit：这些样式不只跑在评论区（.zc 里），
   * 时刻列表那侧没有 --zc-* 变量，写死 #333 会在深色下变成看不见黑字。 */
  .md { word-break: break-word; line-height: 1.7; font-size: 0.92rem; color: var(--zc-fg, inherit); }
  .md :global(p) { margin: 0.35rem 0; }
  .md :global(p:first-child) { margin-top: 0; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4), .md :global(h5), .md :global(h6) {
    margin: 0.6rem 0 0.3rem; font-size: 1rem; line-height: 1.5;
  }
  .md :global(ul), .md :global(ol) { margin: 0.35rem 0; padding-left: 1.4rem; }
  .md :global(blockquote) {
    margin: 0.4rem 0; padding: 0.1rem 0.7rem;
    border-left: 3px solid var(--zc-border, rgba(128, 128, 128, 0.45)); color: var(--zc-muted, inherit);
  }
  .md :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em; background: var(--zc-code-bg, rgba(128, 128, 128, 0.22)); padding: 0.1rem 0.3rem; border-radius: 4px;
  }
  .md :global(pre) {
    margin: 0.4rem 0; padding: 0.6rem; overflow-x: auto;
    background: var(--zc-code-bg, rgba(128, 128, 128, 0.22)); border-radius: 8px;
  }
  .md :global(pre code) { background: none; padding: 0; }
  .md :global(a) { color: var(--zc-accent, var(--logo-accent-text, #0070f3)); text-decoration: none; }
  .md :global(a:hover) { text-decoration: underline; }
  .md :global(img) { max-width: 100%; border-radius: 8px; }
  .md :global(hr) { border: none; border-top: 1px solid var(--zc-border, rgba(128, 128, 128, 0.45)); margin: 0.6rem 0; }
  .md :global(table) { border-collapse: collapse; margin: 0.4rem 0; font-size: 0.9em; }
  .md :global(th), .md :global(td) { border: 1px solid var(--zc-border, rgba(128, 128, 128, 0.45)); padding: 0.2rem 0.5rem; }

  /* 表情图跟着字号走，深底浅底都不加描边（PNG 自带透明） */
  .md :global(img.zc-emoji-img) {
    display: inline-block; height: 1.7em; width: auto; max-width: 1.7em;
    vertical-align: -0.38em; margin: 0 0.06em; border-radius: 0; background: none;
  }
</style>
