<script lang="ts">
  let {
    label,
    file,
    dataDir,
    pending,
    loaded,
    initialized,
    issueCount,
    fallback = 'params.toml',
    onremove,
    oncancel,
  }: {
    label: string;
    file: string;
    dataDir: string;
    pending: 'write' | 'delete' | 'skip';
    loaded: boolean;
    initialized: boolean;
    issueCount: number;
    /** 删掉这份 data 文件之后前台改读什么；只有「友链申请」不是 params.toml */
    fallback?: string;
    onremove: () => void;
    oncancel: () => void;
  } = $props();

  /** props 会变（切标签页），所以路径放在 derived 里算，不要在模块作用域拼字符串 */
  const status = $derived.by(() => {
    const path = `${dataDir}/${file}`;
    if (pending === 'delete') return `保存时删除 ${path}，回落 ${fallback}`;
    if (loaded) return path;
    if (pending === 'write') return `保存后写入 ${path}`;
    if (initialized) return '已初始化，尚未写入';
    return '未配置';
  });
</script>

<div class="row spread bar">
  <div class="row st">
    <span class="muted small">{status}</span>
    {#if issueCount > 0}
      <span class="badge bad">{issueCount} 处需要修正</span>
    {/if}
  </div>
  <div class="row ops">
    {#if loaded && pending !== 'delete'}
      <button class="sm danger" onclick={onremove}>删除覆盖，回落 {fallback}</button>
    {/if}
    {#if initialized && !loaded && pending !== 'delete'}
      <button class="sm ghost" onclick={oncancel}>取消初始化（本段不保存）</button>
    {/if}
  </div>
</div>

<style>
  .bar {
    align-items: center;
    margin-bottom: 0.6rem;
    min-height: 1.6rem;
  }
  .st {
    gap: 0.45rem;
    min-width: 0;
  }
  .ops {
    flex: none;
    white-space: nowrap;
  }
  .badge.bad {
    background: var(--bad-soft);
    color: var(--bad);
  }
</style>
