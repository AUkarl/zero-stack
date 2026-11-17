<script lang="ts">
  import { LIMIT, type HomeSection } from './types';
  import PageHeaderFields from './PageHeaderFields.svelte';

  let { home }: { home: HomeSection } = $props();

  const LAYOUTS: { value: 'bento' | 'grid'; title: string }[] = [
    { value: 'bento', title: 'Bento 精选网格' },
    { value: 'grid', title: 'Grid 卡片网格' },
  ];
</script>

<section class="card blk">
  <h3>页面标题</h3>
  <PageHeaderFields bind:showTitle={home.showTitle} bind:title={home.title} bind:showDesc={home.showDesc} bind:desc={home.desc} defaultTitle="主页" />
</section>

<section class="card blk">
  <h3>首页布局</h3>
  <div class="row spread pick">
    {#each LAYOUTS as o (o.value)}
      <button class="opt" class:on={home.layout === o.value} onclick={() => (home.layout = o.value)} aria-pressed={home.layout === o.value}>
        <span class="ot">{o.title}</span>
      </button>
    {/each}
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
</style>
