<script lang="ts">
  import type { PageHeaderSection } from './types';
  import PageHeaderFields from './PageHeaderFields.svelte';

  let { section = $bindable(), page }: { section: PageHeaderSection; page: string } = $props();
</script>

<section class="card blk">
  <h3>{page}标题</h3>
  <PageHeaderFields bind:showTitle={section.showTitle} bind:title={section.title} bind:showDesc={section.showDesc} bind:desc={section.desc} defaultTitle={page.replace(/页$/, '')} />
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
</style>
