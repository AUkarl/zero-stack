<script lang="ts">
  let {
    label,
    file,
    dataDir,
    onundo,
  }: {
    label: string;
    file: string;
    dataDir: string;
    onundo: () => void;
  } = $props();
</script>

<section class="card gate">
  <h3>{label}：准备删除覆盖</h3>
  <p class="muted">
    点「保存设置」会删除 <code>{dataDir}/{file}</code>，前台这一段重新回落到 params.toml 的配置。
    上面的编辑内容不会保留，随时可以撤销这一步。
  </p>
  <div class="row">
    <button class="sm" onclick={onundo}>撤销，继续编辑</button>
  </div>
</section>

<style>
  .gate {
    border-style: dashed;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .gate h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .gate p {
    margin: 0;
    line-height: 1.65;
  }
  .gate code {
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0 0.25rem;
  }
</style>
