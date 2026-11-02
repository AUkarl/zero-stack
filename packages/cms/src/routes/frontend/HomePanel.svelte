<script lang="ts">
  import { LIMIT, type HomeSection } from './types';

  let { home }: { home: HomeSection } = $props();

  const LAYOUTS: { value: 'bento' | 'grid'; title: string; desc: string }[] = [
    { value: 'bento', title: 'bento 精选网格', desc: '顶部简介 + 精选区（11 个槽位）+ 全部文章等高网格，点击可加载更多' },
    { value: 'grid', title: 'grid 旧版卡片', desc: '等宽等高的卡片网格，做了卡片交错，既保留规整感又增加了瀑布流的感觉' },
  ];
</script>

<section class="card blk">
  <h3>首页布局</h3>
  <p class="muted small">二选一，点一下即切换（保存后才对前台生效）。</p>
  <div class="row spread pick">
    {#each LAYOUTS as o (o.value)}
      <button class="opt" class:on={home.layout === o.value} onclick={() => (home.layout = o.value)} aria-pressed={home.layout === o.value}>
        <span class="ot">{o.title}</span>
        <span class="muted small od">{o.desc}</span>
      </button>
    {/each}
  </div>
  <p class="muted small">当前选择：<strong>{home.layout}</strong>。仅选择 Home 页面风格，具体细节要去 params.toml。</p>
</section>

<section class="card blk">
  <h3>首页描述</h3>
  <label class="switch">
    <input type="checkbox" bind:checked={home.showDesc} />
    <span>显示主页描述（前台标题下方那一行）</span>
  </label>
  <label>
    描述文字
    <textarea rows="2" bind:value={home.desc} maxlength={LIMIT.short} placeholder="这里永远有一摩尔的不确定性"></textarea>
    <span class="muted small">支持 Markdown 与 <code>[[文章标识符]]</code> 短链</span>
    <span class="muted small cnt">{home.desc.length}/{LIMIT.short} 字{home.desc.length >= LIMIT.short ? '（已到上限）' : ''}</span>
  </label>
  <div class="pv">
    <span class="muted small">预览：</span>
    {#if home.showDesc && home.desc.trim()}
      <span class="pvtext">{home.desc.trim()}</span>
    {:else}
      <span class="muted small">（这一行不会显示 —— {home.showDesc ? '文字还是空的' : '开关是关的'}）</span>
    {/if}
  </div>
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
  .pick {
    align-items: stretch;
    gap: 0.6rem;
  }
  .opt {
    flex: 1 1 240px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius);
  }
  .opt.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .ot {
    font-weight: 650;
    color: var(--fg);
    font-size: 0.9rem;
  }
  .opt.on .ot {
    color: var(--accent);
  }
  .od {
    line-height: 1.5;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.88rem;
    color: var(--fg);
  }
  .cnt {
    font-size: 0.72rem;
  }
  .pv {
    border-top: 1px dashed var(--border);
    padding-top: 0.45rem;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .pvtext {
    font-size: 0.9rem;
  }
</style>
