<script lang="ts">
  import { LIMIT } from './types';

  let {
    showTitle = $bindable(true),
    title = $bindable(''),
    showDesc = $bindable(true),
    desc = $bindable(''),
    defaultTitle = '',
  }: {
    showTitle?: boolean;
    title?: string;
    showDesc?: boolean;
    desc?: string;
    defaultTitle?: string;
  } = $props();
</script>

<div class="hrow">
  <label class="switch"><input type="checkbox" bind:checked={showTitle} /><span>显示大标题</span></label>
  <label class="switch"><input type="checkbox" bind:checked={showDesc} /><span>显示描述</span></label>
</div>
<label>大标题<input bind:value={title} maxlength={LIMIT.short} placeholder={defaultTitle} /></label>
<label>标题下的描述<textarea rows="2" bind:value={desc} maxlength={LIMIT.short}></textarea></label>

<style>
  .hrow {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem 1.4rem;
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
</style>