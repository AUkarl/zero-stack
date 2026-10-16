<script lang="ts">
  import { CAP, LIMIT, type FooterIconItem } from './types';

  let { title, hint, items = $bindable() }: { title: string; hint: string; items: FooterIconItem[] } = $props();

  const blank = (): FooterIconItem => ({ name: '', icon: '', img: '', link: '', invert: false });

  function add() {
    if (items.length >= CAP.icons) return;
    items = [...items, blank()];
  }

  function remove(i: number) {
    const it = items[i];
    if (!confirm(`删除「${it.name || it.link || '（空白条目）'}」？`)) return;
    items = items.filter((_, x) => x !== i);
  }

  function move(i: number, dir: -1 | 1) {
    const next = [...items];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    items = next;
  }
</script>

<section class="card blk">
  <div class="row spread">
    <h3>{title}</h3>
    <button class="sm primary" onclick={add} disabled={items.length >= CAP.icons}>＋ 添加一条</button>
  </div>
  <p class="muted small">{hint}</p>
  {#each items as x, i (x)}
    <div class="ic">
      <span class="ord">{i + 1}</span>
      <label class="nm">
        名称
        <input bind:value={x.name} maxlength={LIMIT.short} placeholder="GitHub" />
      </label>
      <label class="ic2">
        图标类名
        <input bind:value={x.icon} maxlength={LIMIT.short} placeholder="fa-brands fa-github" />
      </label>
      <label class="lk">
        地址
        <input bind:value={x.link} maxlength={LIMIT.href} placeholder="https://github.com/你的用户名" />
      </label>
      <label class="im">
        图片路径（填了就优先用图片）
        <input bind:value={x.img} maxlength={LIMIT.href} placeholder="/img/alliance.png" />
      </label>
      <label class="sw">
        <input type="checkbox" bind:checked={x.invert} />
        <span>深色下反色</span>
      </label>
      <div class="row ops">
        <button class="sm" onclick={() => move(i, -1)} disabled={i === 0} title="上移">↑</button>
        <button class="sm" onclick={() => move(i, 1)} disabled={i === items.length - 1} title="下移">↓</button>
        <button class="sm danger" onclick={() => remove(i)}>删除</button>
      </div>
    </div>
  {:else}
    <p class="muted small">还没有条目。</p>
  {/each}
</section>

<style>
  .blk {
    margin-bottom: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .blk h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .ic {
    display: grid;
    grid-template-columns: 1.6rem repeat(4, minmax(140px, 1fr)) auto auto;
    gap: 0.5rem;
    align-items: end;
    border-top: 1px solid var(--border);
    padding: 0.45rem 0;
  }
  .ord {
    font-size: 0.76rem;
    color: var(--muted);
    padding-bottom: 0.5rem;
  }
  .sw {
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .ops {
    flex: none;
    white-space: nowrap;
  }
  @media (max-width: 900px) {
    .ic {
      grid-template-columns: 1.6rem repeat(2, minmax(0, 1fr)) auto;
    }
    .ic .ops {
      grid-column: 3;
      grid-row: 1 / span 3;
      align-self: end;
    }
  }
</style>
