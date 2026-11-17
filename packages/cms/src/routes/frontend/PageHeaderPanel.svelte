<script lang="ts">
  import { LIMIT, type PageHeaderSection } from './types';
  import PageTitleFields from './PageTitleFields.svelte';

  let { section = $bindable(), page }: { section: PageHeaderSection; page: string } = $props();
</script>

<section class="card blk">
  <h3>{page}标题</h3>
  <PageTitleFields bind:showTitle={section.showTitle} bind:title={section.title} defaultTitle={page.replace(/页$/, '')} />
  <label>标题下的描述<textarea rows="2" bind:value={section.desc} maxlength={LIMIT.short}></textarea></label>
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
