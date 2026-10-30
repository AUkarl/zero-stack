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
    if (pending === 'delete') return `「${label}」将在保存时删除 ${path}，前台回落到 ${fallback}`;
    if (loaded) return `「${label}」以 ${path} 为准：这一段有改动就写入，内容没变不会重复写。`;
    if (pending === 'write') return `「${label}」新建覆盖：保存后这一段改用 ${path}，不再读 ${fallback}`;
    if (initialized) return `「${label}」已初始化，但内容和空白模板一模一样，本次不会写入 —— 填内容或取消初始化。`;
    return `「${label}」还没配置：现在编辑的是空白模板，没点「从空白开始填写」之前不会出现在提交内容里`;
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
