<script lang="ts">
  import PageHeaderFields from './PageHeaderFields.svelte';
  import type { PageHeaderSection } from './types';

  let {
    section = $bindable(),
    doubleOptIn = $bindable(true),
    pushEnabled = $bindable(true),
    feedUrl = $bindable(''),
  }: {
    section: PageHeaderSection;
    doubleOptIn?: boolean;
    pushEnabled?: boolean;
    feedUrl?: string;
  } = $props();
</script>

<section class="card blk">
  <h3>订阅页头部</h3>
  <PageHeaderFields bind:showTitle={section.showTitle} bind:title={section.title} bind:showDesc={section.showDesc} bind:desc={section.desc} defaultTitle="订阅" />
</section>

<section class="card blk">
  <h3>订阅设置</h3>
  <label class="switch"><input type="checkbox" bind:checked={doubleOptIn} /><span>双重确认</span></label>
  <label class="switch"><input type="checkbox" bind:checked={pushEnabled} /><span>新文章自动推送</span></label>
  <label>用于比对的 RSS 地址<input bind:value={feedUrl} placeholder="留空按站点地址 + /index.xml" /></label>
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
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    min-height: var(--ctl-h-sm);
    font-size: 0.88rem;
    color: var(--fg);
  }
</style>