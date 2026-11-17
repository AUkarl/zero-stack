<script lang="ts">
  import { LIMIT } from './types';

  let {
    showTitle = $bindable(true),
    title = $bindable(''),
    defaultTitle = '',
  }: { showTitle?: boolean; title?: string; defaultTitle?: string } = $props();
</script>

<div class="tfields">
  <label class="switch"><input type="checkbox" bind:checked={showTitle} /><span>显示大标题</span></label>
  <label>大标题<input bind:value={title} maxlength={LIMIT.short} placeholder={defaultTitle} /></label>
</div>

<style>
  .tfields {
    display: grid;
    grid-template-columns: minmax(150px, 0.35fr) minmax(0, 1fr);
    gap: 0.6rem 0.9rem;
    align-items: center;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    min-height: var(--ctl-h-sm);
    font-size: 0.88rem;
    color: var(--fg);
  }
  @media (max-width: 760px) {
    .tfields {
      grid-template-columns: 1fr;
    }
  }
</style>
