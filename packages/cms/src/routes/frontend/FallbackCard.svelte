<script lang="ts">
  let {
    label,
    file,
    dataDir,
    fallback = 'params.toml',
    oninit,
  }: {
    /** 段落中文名，例如「导航栏」 */
    label: string;
    /** data 目录下的文件名，例如 nav.json */
    file: string;
    dataDir: string;
    /** 这份文件不存在时前台读的是哪里 */
    fallback?: string;
    oninit: () => void;
  } = $props();
</script>

<section class="card gate">
  <h3>{label}：目前用的是 {fallback}</h3>
  <p class="muted">
    这里改的是 <code>{dataDir}/{file}</code>；当前前台仍读 {fallback}，下面的空白框不是站点当前值。
  </p>
  <div class="row">
    <button class="sm primary" onclick={oninit}>从空白开始填写</button>
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
    background: var(--panel-2);
    border-radius: 4px;
    padding: 0 0.25rem;
  }
</style>
