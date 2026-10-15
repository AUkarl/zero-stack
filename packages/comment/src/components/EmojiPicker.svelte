<script lang="ts">
  import type { EmojiPack } from '../lib/emoji-packs';
  import { tr } from '../lib/i18n';

  let {
    packs = [],
    lang = '',
    onpick,
    onclose,
  }: {
    packs?: EmojiPack[];
    lang?: string;
    onpick: (text: string) => void;
    onclose?: () => void;
  } = $props();

  const t = $derived(tr(lang));

  /** 记住用户最后一次用的 tab：切库后下次打开还在同一组 */
  const STORAGE = 'zero-comment-emoji-tab';
  let active = $state('');
  let triedRestoring = $state(false);

  /* packs 是异步配置算出来的（后台那组可能要等 /api/config），所以这里用 effect 兜：
   * active 不在列表里就先试本地上次用的，再退回第一组。 */
  $effect(() => {
    if (packs.some((p) => p.id === active)) return;
    let saved = '';
    if (!triedRestoring) {
      triedRestoring = true;
      try {
        saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE) || '' : '';
      } catch {
        saved = '';
      }
    }
    active = packs.some((p) => p.id === saved) ? saved : (packs[0]?.id ?? '');
  });

  function pick(pack: EmojiPack) {
    active = pack.id;
    try {
      localStorage.setItem(STORAGE, pack.id);
    } catch {
      // 存不下无所谓，下次回到默认组
    }
  }

  const current = $derived(packs.find((p) => p.id === active) ?? packs[0]);
  const images = $derived(current?.images ?? []);
  const texts = $derived(current?.items ?? []);

  /** CDN 挂掉的图：这一格退成 token 文本，宁可丑也不留裂图 */
  let broken = $state<Record<string, boolean>>({});
</script>

<div class="picker" role="group" aria-label={t('emoji')}>
  <div class="tabs" role="tablist">
    {#each packs as pack (pack.id)}
      <button
        type="button"
        role="tab"
        aria-selected={pack.id === active}
        class:active={pack.id === active}
        onclick={() => pick(pack)}
      >
        {pack.label}
      </button>
    {/each}
    {#if onclose}
      <button type="button" class="close" onclick={onclose} aria-label={t('closePanel')}>×</button>
    {/if}
  </div>

  {#if current}
    <div class="items">
      {#each images as em (em.token)}
        <button
          type="button"
          class="cell"
          title={em.token}
          aria-label={em.token}
          onclick={() => onpick(em.token)}
        >
          {#if broken[em.token]}
            <span class="tok">{em.token}</span>
          {:else}
            <img
              src={em.src}
              alt={em.token}
              loading="lazy"
              decoding="async"
              onerror={() => (broken[em.token] = true)}
            />
          {/if}
        </button>
      {/each}
      {#each texts as em (em)}
        <button type="button" class:wide={em.length > 4} title={em} onclick={() => onpick(em)}>{em}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: absolute; bottom: calc(100% + 0.35rem); left: 0; z-index: 20;
    width: min(24rem, 86vw); box-sizing: border-box;
    border: 1px solid var(--zc-border, #e2e2e2); border-radius: 10px;
    background: var(--zc-bg, #fff); box-shadow: var(--zc-shadow, 0 8px 24px rgba(0, 0, 0, 0.12));
    padding: 0.35rem;
  }
  .tabs { display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap; padding-bottom: 0.35rem; border-bottom: 1px solid var(--zc-border, #e2e2e2); }
  .tabs button {
    font: inherit; font-size: 0.75rem; line-height: 1.4; padding: 0.12rem 0.5rem; cursor: pointer;
    border: 1px solid transparent; border-radius: 999px; background: none; color: var(--zc-muted, #888);
  }
  .tabs button:hover { color: var(--zc-fg, #333); }
  .tabs button.active {
    color: var(--zc-accent, #0070f3); border-color: var(--zc-accent, #0070f3);
    background: var(--zc-tint, rgba(0, 112, 243, 0.1));
  }
  .tabs .close { margin-left: auto; font-size: 1rem; line-height: 1; color: var(--zc-muted, #888); }
  .items {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(2.15rem, 1fr)); gap: 0.1rem;
    max-height: 12rem; overflow-y: auto; padding-top: 0.35rem;
  }
  .items button {
    border: none; background: none; font-family: inherit; font-size: 1.1rem; line-height: 1.35;
    padding: 0.18rem 0.3rem; border-radius: 6px; cursor: pointer; color: var(--zc-fg, #333);
    min-width: 0; display: flex; align-items: center; justify-content: center;
  }
  .items button:hover { background: var(--zc-code-bg, #f2f2f2); }
  /* 颜文字那些长的自己占一整行，别把面板挤成竖条 */
  .items button.wide { font-size: 0.78rem; grid-column: 1 / -1; justify-content: flex-start; }
  .items button.cell { aspect-ratio: 1; padding: 0.2rem; }
  .items img { width: 100%; height: 100%; max-width: 1.9rem; object-fit: contain; display: block; }
  .items .tok { font-size: 0.6rem; line-height: 1.2; color: var(--zc-muted, #888); word-break: break-all; }
</style>
