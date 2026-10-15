<svelte:options
  customElement={{
    tag: 'zero-moments',
    props: {
      apiBase: { attribute: 'api-base', type: 'String' },
      pageSize: { attribute: 'page-size', type: 'Number' },
      shortBase: { attribute: 'short-base', type: 'String' },
    },
  }}
/>
<script lang="ts">
  import { apiFetch, resolveBase, timeAgo } from '../lib/api';
  import { hostAccent } from '../lib/theme.svelte';
  import Markdown from './Markdown.svelte';

  interface Moment {
    id: string;
    content: string;
    media: string[];
    location: string | null;
    source: string;
    sourceUrl: string | null;
    createdAt: number;
  }

  let { apiBase = '', pageSize = 20, shortBase = '/post/' }: { apiBase?: string; pageSize?: number; shortBase?: string } = $props();
  const base = $derived(resolveBase(apiBase));

  let items = $state<Moment[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(true);
  let more = $state(false);
  let error = $state('');

  async function fetchPage(reset: boolean) {
    if (!base) {
      error = '未配置 api-base';
      loading = false;
      return;
    }
    if (reset) {
      items = [];
      cursor = null;
    }
    reset ? (loading = true) : (more = true);
    try {
      const q = new URLSearchParams({ limit: String(pageSize) });
      if (!reset && cursor) q.set('cursor', cursor);
      const d = await apiFetch<{ data: { moments: Moment[]; nextCursor: string | null } }>(
        base,
        `/api/moments?${q}`,
      );
      items = [...items, ...d.data.moments];
      cursor = d.data.nextCursor;
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : '加载失败';
    } finally {
      loading = more = false;
    }
  }

  $effect(() => {
    if (base) void fetchPage(true);
  });

  const SOURCE_LABEL: Record<string, string> = {
    manual: '',
    weibo: '微博',
    twitter: 'X',
    qqzone: 'QQ空间',
    wechat: '朋友圈',
  };
</script>

<div class="zm" use:hostAccent>
  {#if loading}<p class="hint">加载中…</p>
  {:else if error && items.length === 0}<p class="hint">{error}</p>
  {:else if items.length === 0}<p class="hint">还没有内容。</p>
  {/if}

  {#each items as m (m.id)}
    <article class="card">
      <div class="head">
        <span class="dot"></span>
        <time>{timeAgo(m.createdAt)}</time>
        {#if m.location}<span class="loc">📍 {m.location}</span>{/if}
        {#if SOURCE_LABEL[m.source]}<span class="src">{SOURCE_LABEL[m.source]}</span>{/if}
      </div>
      <div class="text"><Markdown text={m.content} {shortBase} /></div>
      {#if m.media?.length}
        <div class="media" class:one={m.media.length === 1}>
          {#each m.media as src}
            <img src={src} alt="" loading="lazy" />
          {/each}
        </div>
      {/if}
      {#if m.sourceUrl}<a class="origin" href={m.sourceUrl} target="_blank" rel="noopener noreferrer">查看原帖</a>{/if}
    </article>
  {/each}

  {#if cursor}
    <button class="load" disabled={more} onclick={() => void fetchPage(false)}>{more ? '加载中…' : 'Load More'}</button>
  {/if}
</div>

<style>
  /* 宿主主题的 --card-bg/--border/--text-* 在深色下会被重写，这里只留浅色兜底值 */
  .zm { display: flex; flex-direction: column; gap: 1rem; color: var(--text, #333); }
  .hint { color: var(--text-secondary, #888); font-size: 0.9rem; }
  .card { border: 1px solid var(--border, #eee); border-radius: 12px; padding: 1rem 1.1rem; background: var(--card-bg, #fff); }
  .head { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; color: var(--text-secondary, #888); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--logo-accent-text, #0070f3); }
  .loc, .src { color: var(--text-secondary, #aaa); }
  .text { margin: 0.6rem 0 0; line-height: 1.7; }
  .media { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.4rem; margin-top: 0.6rem; }
  .media.one { grid-template-columns: minmax(0, 320px); }
  .media img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; }
  .media.one img { aspect-ratio: auto; }
  .origin { display: inline-block; margin-top: 0.5rem; font-size: 0.8rem; color: var(--logo-accent-text, #0070f3); text-decoration: none; }
  .load { align-self: center; border: 1px solid var(--border, #e2e2e2); background: var(--card-bg, #fff); border-radius: 999px; padding: 0.4rem 1.4rem; font: inherit; cursor: pointer; color: var(--text-secondary, #444); }
  .load:disabled { opacity: 0.6; }
</style>
