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
    当前前台这一段读的是 {fallback}；在这里保存后改以 <code>{dataDir}/{file}</code> 为准。
  </p>
  <ul class="muted small">
    <li>后台没有 TOML 解析，读不到 {fallback} 里到底写了什么，所以下面的空白框不是站点当前值。</li>
    <li>一旦保存，这一整段就改成以 <code>{dataDir}/{file}</code> 为准：要把前台现有内容保留下来，请先照着前台把它填全。</li>
    <li>不想覆盖就别点保存 —— 本段在没有初始化、也没有改动时不会出现在提交内容里。</li>
  </ul>
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
  .gate ul {
    margin: 0;
    padding-left: 1.1rem;
    line-height: 1.7;
  }
  .gate code {
    background: var(--panel-2);
    border-radius: 4px;
    padding: 0 0.25rem;
  }
</style>
