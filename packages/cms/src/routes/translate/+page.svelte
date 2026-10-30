<script lang="ts">
  import { get, patch, post } from '#lib/api';

  /**
 * 翻译工作台：选文章（原文可为任意语言）→ 选目标语言与翻译服务 → 一键译成
 * → 可编辑预览 → 发布译文（写入 content/<目标语言>/posts）。
   *
   * 后端口子（都在 /api/admin/translate 下）：
   *   GET  /status      provider / 是否就绪 / 可选 provider 清单（含是否需要 key）
   *   GET  /documents   列 content/zh/posts 已发布文章（后端缓存 5 分钟），无语言参数
   *   POST /document    {path} 正文按段落译成简体中文，返回可编辑草稿，不写盘
   *   POST /publish     {path,front,body,message,overwrite} 写入 content/<目标语言>/posts/<源文件名>.md 并触发重建
   *   PATCH /api/admin/config  只写 translateProvider；端点 / 模型 / 密钥在「设置 → 机器翻译」
   *
   * provider 的 kind 字符串必须与后端 services/translate.ts 的 PRESETS、设置页下拉完全一致。
   */

  interface ProviderInfo {
    kind: string;
    label: string;
    needsKey: boolean;
    family: 'none' | 'workers' | 'chat' | 'public' | 'keyed' | 'free';
  }
  interface TrStatus {
    provider: string;
    model: string;
    ready: boolean;
    hint: string;
    family: string;
    needsKey: boolean;
    providers: ProviderInfo[];
    targets?: { code: string; label: string }[];
    defaultTarget?: string;
  }
  interface Doc {
    id: string;
    path: string;
    title: string;
    date: string;
  }

  let status = $state<TrStatus | null>(null);
  let loading = $state(false);
  let error = $state('');
  let notice = $state('');

  /* -------- 服务选择：只选 provider，端点/模型/密钥统一在「设置 → 机器翻译」 -------- */
  let provider = $state('none');
  let savingProvider = $state(false);

  /* -------- 工作台：原文（可为外文）→ 中文，单向流程 -------- */
  let docs = $state<Doc[]>([]);
  let docPath = $state('');
  let docLoading = $state(false);
  let translating = $state(false);

  let zhFront = $state<Record<string, unknown>>({});
  let trTitle = $state('');
  let trDescription = $state('');
  let trSummary = $state('');
  let trBody = $state('');
  let srcTitle = $state('');
  let withInfo = $state<{ provider: string; segments: number; retries: number } | null>(null);

  /* -------- 发布中文稿 -------- */
  let publishMsg = $state('');
  /** 目标语言：zh/en/ru/fr/de/es/ar/ja/ko，选项来自后端 */
  let target = $state('zh');
  let overwrite = $state(false);
  let publishing = $state(false);
  let published: { path: string; backend: string; build: { triggered: boolean; error?: string } } | null | undefined = $state(undefined);

  const selectedDoc = $derived(docs.find((d) => d.path === docPath) ?? null);
  const currentProviders = $derived(status?.providers ?? []);
  const activeProviderInfo = $derived(currentProviders.find((p) => p.kind === provider) ?? null);
  const targetOptions = $derived(status?.targets ?? [{ code: 'zh', label: '简体中文' }]);
  const targetName = $derived(targetOptions.find((t) => t.code === target)?.label ?? '简体中文');

  function flash(msg: string) {
    notice = msg;
    setTimeout(() => (notice = ''), 2600);
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const st = await get<{ data: TrStatus }>('/api/admin/translate/status');
      status = st.data;
      provider = st.data.provider || 'none';
    } catch (e) {
      error = e instanceof Error ? e.message : '读取翻译状态失败';
      status = null;
    } finally {
      loading = false;
    }
  }

  /**
   * 选完服务立刻写回 translateProvider（端点/模型/密钥在设置页维护）。
   * 写回后再拉一次状态：是否「可用」取决于设置页里那份配置，不能拿旧状态骗自己。
   */
  async function onProviderChange() {
    savingProvider = true;
    error = '';
    try {
      await patch('/api/admin/config', { translateProvider: provider });
      const st = await get<{ data: TrStatus }>('/api/admin/translate/status');
      status = st.data;
      flash(st.data.ready ? `已切换到 ${provider}` : `已切换到 ${provider}，还缺端点/密钥，去「设置 → 机器翻译」补齐`);
    } catch (e) {
      error = e instanceof Error ? e.message : '保存翻译服务失败';
    } finally {
      savingProvider = false;
    }
  }

  async function loadDocs() {
    docLoading = true;
    error = '';
    try {
      const d = await get<{ data: { documents: Doc[] } }>('/api/admin/translate/documents');
      docs = d.data.documents ?? [];
      docPath = docs[0]?.path ?? '';
    } catch (e) {
      error = e instanceof Error ? e.message : '读取文章列表失败';
      docs = [];
    } finally {
      docLoading = false;
    }
  }

  async function doTranslate() {
    error = '';
    published = undefined;
    if (!docPath) {
      flash('先选一篇要翻译的文章');
      return;
    }
    translating = true;
    try {
      const d = await post<{
        data: {
          source: { path: string; title: string };
          result: { front: Record<string, unknown>; body: string; translatedWith: { provider: string; segments: number; retries: number } };
        };
      }>('/api/admin/translate/document', { path: docPath, target });
      const r = d.data;
      zhFront = r.result.front ?? {};
      trTitle = String(r.result.front?.title ?? '');
      trDescription = String(r.result.front?.description ?? '');
      trSummary = String(r.result.front?.summary ?? '');
      trBody = r.result.body ?? '';
      srcTitle = r.source?.title ?? '';
      withInfo = r.result.translatedWith ?? null;
      publishMsg = `发布${targetName}稿：${srcTitle}`.slice(0, 180);
      flash(`已译成${targetName}（${withInfo?.provider ?? '?'} · ${withInfo?.segments ?? 0} 段${withInfo?.retries ? ` · 重试 ${withInfo.retries}` : ''}）`);
    } catch (e) {
      error = e instanceof Error ? e.message : '翻译失败';
    } finally {
      translating = false;
    }
  }

  async function doPublish() {
    error = '';
    if (!docPath || (!trBody && !trTitle)) {
      flash(`没有可发布的${targetName}稿，请先翻译`);
      return;
    }
    publishing = true;
    published = undefined;
    try {
      const front = { ...zhFront, title: trTitle, description: trDescription, summary: trSummary };
      const d = await post<{
        data: { path: string; backend: string; build: { triggered: boolean; error?: string } };
      }>('/api/admin/translate/publish', {
        path: docPath,
        front,
        body: trBody,
        message: publishMsg || undefined,
        target,
        overwrite,
      });
      published = d.data;
      flash(`已写入 ${d.data.path}`);
    } catch (e) {
      error = e instanceof Error ? e.message : '发布失败';
    } finally {
      publishing = false;
    }
  }

  /** 当前编辑态拼出将要发布的完整 markdown，用于诚实预览 */
  const previewMd = $derived.by(() => {
    const lines: string[] = [];
    const front = { ...zhFront, title: trTitle, description: trDescription, summary: trSummary };
    lines.push('---');
    for (const [k, v] of Object.entries(front)) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        lines.push(`${k}:`);
        for (const it of v) lines.push(`  - ${String(it)}`);
      } else if (typeof v === 'object') {
        lines.push(`${k}:`);
        for (const [sk, sv] of Object.entries(v as Record<string, string>)) lines.push(`  ${sk}: ${String(sv)}`);
      } else lines.push(`${k}: ${String(v)}`);
    }
    lines.push('---', '', trBody);
    return lines.join('\n');
  });

  const hasResult = $derived(Boolean(withInfo) && (trBody !== '' || trTitle !== ''));

  $effect(() => {
    void (async () => {
      await load();
      void loadDocs();
    })();
  });
</script>

<div class="row spread head">
  <h2>翻译工作台</h2>
  <div class="row">
    <span class="muted small">
      当前：{status ? `${status.provider}${status.model ? ` · ${status.model}` : ''}` : '—'}
      {#if status}<span class="badge {status.ready ? 'good' : 'pending'}">{status.ready ? '可用' : '未就绪'}</span>{/if}
    </span>
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
  </div>
</div>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

{#if status && !status.ready}
  <section class="card blk guide">
    <h3>还没有可用的翻译服务</h3>
    <p class="muted small">{status.hint || '未配置翻译服务。'}</p>
    <p class="small">
      最快上手（免密钥）：在下方「服务」里选 <strong>MyMemory</strong>，直接点「一键译成…」即可。
      公共接口配额低，只适合先跑通。
    </p>
    <p class="small">
      免费额度：选 <strong>百度翻译</strong> 或 <strong>有道翻译</strong>，到
      <a href="/settings">「设置 → 机器翻译」</a> 填好对应的 App ID / 密钥即可。
      要更好的效果：选 <strong>deepseek / qianwen / moonshot / doubao / grok / zhipu / openai</strong>，
      在设置里填 API Key 与模型。译文语言在开始翻译前选。
    </p>
  </section>
{/if}

<section class="card blk">
  <h3>工作台：原文 → {targetName}</h3>
  <div class="work">
    <div class="col">
      <span class="lbl">1 · 原文（可为任意语言）</span>
      <label>
        文章（仅已发布）
        <select bind:value={docPath} disabled={docLoading}>
          {#if docLoading}<option value="">读取中…</option>{/if}
          {#if !docLoading && !docs.length}<option value="">（没有可选文章）</option>{/if}
          {#each docs as d (d.path)}
            <option value={d.path}>{d.title || d.path}</option>
          {/each}
        </select>
      </label>
      <button class="sm" onclick={() => void loadDocs()} disabled={docLoading}>{docLoading ? '读取中…' : '刷新文章列表'}</button>
      {#if selectedDoc}<p class="muted small path">{selectedDoc.path}</p>{/if}
原文可以是任意语言，译文写进上面选的目标语言。
    </div>

    <div class="col">
      <span class="lbl">2 · 目标语言与翻译服务</span>
      <label>
        译成
        <select bind:value={target}>
          {#each targetOptions as t (t.code)}<option value={t.code}>{t.label}</option>{/each}
        </select>
      </label>
      <label>
        服务
        <select bind:value={provider} onchange={onProviderChange} disabled={savingProvider}>
          {#each currentProviders as p (p.kind)}
            <option value={p.kind}>{p.label}{p.kind === 'none' ? '' : p.needsKey ? '（需密钥）' : '（免密钥）'}</option>
          {/each}
        </select>
      </label>
      <p class="muted small">
        端点、模型、密钥和百度/有道凭据都在
        <a href="/settings">「设置 → 机器翻译」</a>
        里改，这里只选服务。
      </p>
      {#if activeProviderInfo?.family === 'public'}
        <p class="muted small">免费公共接口，无需密钥，配额低，失败会原样报错。</p>
      {:else if activeProviderInfo?.family === 'keyed'}
        <p class="muted small">需要在设置里填好该服务商的 App ID / 密钥；免费额度用完会返回服务商原文。</p>
      {/if}
      <button class="primary" onclick={() => void doTranslate()} disabled={translating || !docPath || savingProvider}>
        {translating ? '翻译中…' : `一键译成${targetName}`}
      </button>
    </div>
  </div>
</section>

{#if hasResult}
  <section class="card blk edit">
    <h3>3 · 编辑{targetName}稿</h3>
    {#if withInfo}
      <p class="muted small">
        由 {withInfo.provider} 译成{targetName} · {withInfo.segments} 段
date/author/comments 等字段保持不变，仅标题/摘要/描述与正文翻译。
      </p>
    {/if}
    <div class="fields">
      <label class="tight">标题<input bind:value={trTitle} /></label>
      <label class="tight">摘要 description<input bind:value={trDescription} /></label>
      <label class="tight">导语 summary<input bind:value={trSummary} /></label>
    </div>
    <label class="tight">正文（Markdown，可编辑）
      <textarea rows="14" bind:value={trBody}></textarea>
    </label>

    <div class="pubrow">
      <label class="tight grow">提交说明（可选）<input bind:value={publishMsg} placeholder="写进仓库的说明" /></label>
      <label class="chk"><input type="checkbox" bind:checked={overwrite} /> 覆盖已存在文件</label>
      <button class="primary" onclick={() => void doPublish()} disabled={publishing}>{publishing ? '发布中…' : `发布${targetName}稿`}</button>
    </div>
    <p class="muted small">写进 content/&lt;目标语言&gt;/posts/&lt;源文件名&gt;.md。目标语言不是站点默认语言时，要先在 hugo.toml 配好那门语言，否则后端会拒绝（写进去也不会出现在前台）。</p>

    {#if published}
      <p class="ok">
        已写入：<strong>{published.path}</strong>（后端 {published.backend}） ·
        重建：{published.build.triggered ? '已触发 Pages 构建' : `未触发——${published.build.error ?? '等下一次自动构建'}`}
      </p>
    {/if}
  </section>

  <section class="card blk">
    <h3>预览（将写入仓库的完整 md）</h3>
    <pre class="md">{previewMd}</pre>
  </section>
{/if}

<style>
  .head {
    margin-bottom: 0.7rem;
  }
  .small {
    font-size: 0.76rem;
  }
  .blk {
    margin-bottom: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .blk h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .guide {
    border-color: var(--accent);
  }
  .work {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 0.9rem;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border-left: 2px solid var(--border);
    padding-left: 0.7rem;
  }
  .lbl {
    font-size: 0.78rem;
    color: var(--muted);
    font-weight: 600;
  }
  .tight {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  .fields {
    display: grid;
    gap: 0.5rem;
  }
  .pubrow {
    display: flex;
    align-items: flex-end;
    gap: 0.7rem;
    flex-wrap: wrap;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
  }
  textarea,
  pre.md {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.84rem;
    line-height: 1.6;
  }
  pre.md {
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg-soft, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.7rem;
    max-height: 360px;
    overflow: auto;
    margin: 0;
  }
  .path {
    word-break: break-all;
  }
</style>
