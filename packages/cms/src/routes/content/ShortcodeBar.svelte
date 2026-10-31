<script lang="ts">
  import { SHORTCODES, type Shortcode } from './_shortcodes';

  let { oninsert, onmedia }: { oninsert: (sc: Shortcode) => void; onmedia?: () => void } = $props();

  const groups = $derived.by(() => {
    const out: { name: string; items: Shortcode[] }[] = [];
    for (const sc of SHORTCODES) {
      const g = out.find((x) => x.name === sc.group);
      if (g) g.items.push(sc);
      else out.push({ name: sc.group, items: [sc] });
    }
    return out;
  });

  let picked = $state('');

  function fire() {
    const sc = SHORTCODES.find((x) => x.label === picked);
    if (!sc) return;
    oninsert(sc);
    picked = '';
  }
</script>

<div class="sc">
  <select class="sel" bind:value={picked} aria-label="选择要插入的短代码">
    <option value="">插入短代码…</option>
    {#each groups as g (g.name)}
      <optgroup label={g.name}>
        {#each g.items as sc (sc.label)}<option value={sc.label}>{sc.label}</option>{/each}
      </optgroup>
    {/each}
  </select>
  <button type="button" class="sm" onclick={fire} disabled={!picked}>插入</button>
  {#if onmedia}
    <button type="button" class="sm" onclick={onmedia}>插入媒体</button>
  {/if}
  <span class="muted small">插入位置跟随光标；短代码名与参数取自主题 shortcodes 目录</span>
</div>

<style>
  .sc {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }
  .sel {
    height: 30px;
    min-height: 30px;
    padding: 0.18rem 1.8rem 0.18rem 0.55rem;
    font-size: 0.82rem;
  }
  .small {
    font-size: 0.74rem;
  }
</style>
