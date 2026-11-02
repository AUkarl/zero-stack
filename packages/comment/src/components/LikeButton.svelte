<svelte:options
  customElement={{
    tag: 'zero-like',
    props: {
      apiBase: { attribute: 'api-base', type: 'String' },
      postSlug: { attribute: 'post-slug', type: 'String' },
      kind: { attribute: 'kind', type: 'String' },
      showCount: { attribute: 'show-count', type: 'Boolean' },
    },
  }}
/>
<script lang="ts">
  import { apiFetch, resolveBase } from '../lib/api';
  import { session } from '../lib/session.svelte';

  let {
    apiBase = '',
    postSlug = '',
    kind = 'like',
    showCount = true,
  }: { apiBase?: string; postSlug?: string; kind?: string; showCount?: boolean } = $props();

  const base = $derived(resolveBase(apiBase));
  const slug = $derived(postSlug || (typeof document !== 'undefined' ? location.pathname : '/'));
  const isStar = $derived(kind === 'star');

  let active = $state(false);
  let count = $state(0);
  let busy = $state(false);
  let popping = $state(false);

  $effect(() => {
    if (!base) return;
    session.init(base);
    apiFetch<{ data: Record<string, { count: number; active: boolean }> }>(
      base,
      `/api/reactions?slugs=${encodeURIComponent(slug)}&kind=${isStar ? 'star' : 'like'}`,
    )
      .then((d) => {
        const entry = d.data[slug];
        if (entry) {
          count = entry.count;
          active = entry.active;
        }
      })
      .catch(() => {});
  });

  async function toggle() {
    if (!base || busy) return;
    busy = true;
    const wasActive = active;
    active = !wasActive;
    count = Math.max(0, count + (wasActive ? -1 : 1));
    try {
      const d = await apiFetch<{ data: { active: boolean; count: number } }>(base, '/api/reactions', {
        method: 'POST',
        body: JSON.stringify({ slug, kind: isStar ? 'star' : 'like' }),
      });
      active = d.data.active;
      count = d.data.count;
    } catch {
      active = wasActive;
      count = Math.max(0, count + (wasActive ? 1 : -1));
    } finally {
      busy = false;
    }
    if (active !== wasActive) popping = true;
  }
</script>

<button class:active class:star={isStar} class:pop={popping} onclick={toggle} disabled={busy} aria-pressed={active} title={isStar ? '收藏' : '点赞'}><span class="icon" onanimationend={() => (popping = false)}>{active ? (isStar ? '★' : '♥') : (isStar ? '☆' : '♡')}</span
  >{#if showCount}<span class="n">{count}</span>{/if}</button>

<style>
  /* 底色、边框、文字吃宿主那一组 --zero-chip-*（自定义属性穿透 shadow DOM），
     两颗胶囊形状、字号、动画完全一致，只有激活颜色分开：点赞玫红、收藏琥珀黄。 */
  button {
    display: inline-flex; align-items: center; gap: 0.3rem;
    border: 1px solid var(--zero-chip-border, #e2e2e2); background: var(--zero-chip-bg, #fff); color: var(--zero-chip-fg, #666);
    border-radius: 999px; padding: 0.22rem 0.75rem; font: inherit; font-size: 0.85rem; line-height: 1.4; cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  button:hover { color: var(--zero-react-fg, #e0245e); border-color: currentColor; }
  button.active { color: var(--zero-react-fg, #e0245e); border-color: currentColor; }
  button.star:hover, button.star.active { color: var(--zero-star-fg, #e0a100); }
  /* 图标占一个固定宽的格子：♡ 与 ☆ 的字面宽度本来就差 2px，
     不给死宽度，点赞与收藏两颗胶囊就没法等宽（文章操作条上是并排的）。 */
  .icon { font-size: 0.95rem; line-height: 1; display: inline-block; width: 1.1em; text-align: center; }
  /* 点下去弹一下，与主题侧 zero.css 的 .zst-btn.is-pop 同名同参数 */
  button.pop .icon { animation: react-pop 0.26s ease; }
  @keyframes react-pop {
    0%   { transform: scale(1); }
    35%  { transform: scale(1.22); }
    100% { transform: scale(1); }
  }
  .n { min-width: 1.2em; text-align: left; }
</style>
