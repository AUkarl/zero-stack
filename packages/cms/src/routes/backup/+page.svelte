<script lang="ts">
  import { del, get, post } from '#lib/api';
  import { fmtDate } from '#lib/api';

  interface Object_ {
    key: string;
    size: number;
    uploaded: string | null;
  }
  interface ExportResult {
    key: string;
    counts: Record<string, number>;
    warnings: string[];
    pruned: number;
  }
  interface Payload {
    version: number;
    scope: string;
    createdAt: number;
    siteName: string;
    counts: Record<string, number>;
    tables: Record<string, unknown[]>;
  }
  interface Outcome {
    dryRun: boolean;
    tables: { name: string; rows: number; inserted: number; skipped: number; note: string | null }[];
    errors: string[];
  }

  let objects = $state<Object_[]>([]);
  let loading = $state(false);
  let busy = $state('');
  let error = $state('');
  let notice = $state('');

  let scope = $state<'core' | 'full'>('core');
  let withSecrets = $state(false);
  let lastExport = $state<ExportResult | null>(null);

  let picked = $state<{ name: string; payload: Payload } | null>(null);
  let outcome = $state<Outcome | null>(null);

  async function load() {
    loading = true;
    try {
      const d = await get<{ data: Object_[] }>('/api/admin/backup/list');
      objects = d.data;
    } catch (e) {
      error = e instanceof Error ? e.message : '备份列表读取失败';
    } finally {
      loading = false;
    }
  }

  /** 导出到浏览器：不落 R2，直接下载 json */
  async function download() {
    busy = 'download';
    error = '';
    try {
      const d = await get<Payload>(`/api/admin/backup/export?scope=${scope}`);
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zero-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notice = '已导出到本地文件';
    } catch (e) {
      error = e instanceof Error ? e.message : '导出失败';
    } finally {
      busy = '';
    }
  }

  /** 存档到 R2，保留最近 10 份 */
  async function archive() {
    busy = 'archive';
    error = '';
    try {
      const qs = new URLSearchParams({ scope, save: '1' });
      if (withSecrets) qs.set('secrets', '1');
      const d = await get<{ data: ExportResult }>(`/api/admin/backup/export?${qs}`);
      lastExport = d.data;
      notice = `已存档 ${d.data.key}${d.data.pruned ? `，清理旧备份 ${d.data.pruned} 份` : ''}`;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '存档失败';
    } finally {
      busy = '';
    }
  }

  async function downloadKey(key: string) {
    error = '';
    try {
      const raw = await fetch(`/api/admin/backup/file?key=${encodeURIComponent(key)}`, { credentials: 'include' });
      if (!raw.ok) throw new Error(`取回失败 (${raw.status})`);
      const text = await raw.text();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = key.split('/').pop() ?? 'backup.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      error = e instanceof Error ? e.message : '取回失败';
    }
  }

  async function removeObject(o: Object_) {
    if (!confirm(`删除备份 ${o.key}？`)) return;
    busy = o.key;
    error = '';
    try {
      await del(`/api/admin/backup/file?key=${encodeURIComponent(o.key)}`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '删除失败';
    } finally {
      busy = '';
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    error = '';
    outcome = null;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Payload;
      if (!parsed || typeof parsed !== 'object' || !parsed.tables) throw new Error('这不是 zero-api 导出的备份文件（缺少 tables 字段）');
      picked = { name: file.name, payload: parsed };
    } catch (e) {
      error = e instanceof Error ? e.message : '文件解析失败';
      picked = null;
    }
  }

  /** 导入分两步：先演习看影响面，确认后再真写 */
  async function runImport(dryRun: boolean) {
    if (!picked) return;
    busy = dryRun ? 'dry' : 'apply';
    error = '';
    outcome = null;
    try {
      const d = await post<{ data: Outcome }>('/api/admin/backup/import', { payload: picked.payload, dryRun });
      outcome = d.data;
      if (!dryRun) {
        notice = '导入完成，建议到「设置」逐项确认配置';
        picked = null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : '导入失败';
    } finally {
      busy = '';
    }
  }

  function kb(n: number): string {
    return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`;
  }

  /* ------------------------------------------------------------ 评论导入 */

  interface CommentPlan {
    dryRun: boolean;
    format: string;
    total: number;
    rows: number;
    skipped: { reason: string; count: number }[];
    slugs: { slug: string; count: number }[];
    notice: string | null;
    summary: string;
    applied?: { inserted: number; skipped: number };
  }

  const FORMATS: [string, string][] = [
    ['', '自动识别'],
    ['waline', 'Waline'],
    ['twikoo', 'Twikoo'],
    ['artalk', 'Artalk'],
    ['giscus', 'Giscus'],
    ['commentbox', 'CommentBox'],
    ['generic', '通用 JSON'],
    ['zero', '本站备份'],
  ];

  let cf = $state<{ name: string; kind: 'json' | 'csv'; text: string } | null>(null);
  let cFormat = $state('');
  let cStatus = $state('keep');
  let cPlan = $state<CommentPlan | null>(null);

  async function pickCommentFile(file: File | undefined) {
    if (!file) return;
    error = '';
    cPlan = null;
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error('这个文件是空的');
      const isCsv = /\.csv$/i.test(file.name) || (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[') && text.includes(','));
      let kind: 'json' | 'csv' = 'csv';
      let payloadText = text;
      if (!isCsv) {
        kind = 'json';
        // 先在本机解一次 JSON：文件坏了当场就说，不必等后端回 400
        JSON.parse(text);
      } else {
        payloadText = text;
      }
      cf = { name: file.name, kind, text: payloadText };
    } catch (e) {
      error = e instanceof Error ? e.message : '文件读取失败';
      cf = null;
    }
  }

  /** 与整库导入一样：先演习看清影响面，确认后才真写 */
  async function runCommentImport(dryRun: boolean) {
    if (!cf) return;
    busy = dryRun ? 'cdry' : 'capply';
    error = '';
    if (!dryRun) {
      if (!cPlan?.dryRun) {
        error = '必须先看一次演习结果，才允许真写';
        busy = '';
        return;
      }
      if (!confirm(`确认把 ${cPlan.rows} 条评论写入数据库？\n\n识别格式：${cPlan.format}\n写入的每条都会打「历史数据」标记，重复导入同一份文件不会翻倍。`)) {
        busy = '';
        return;
      }
    }
    try {
      const body = cf.kind === 'csv' ? { csv: cf.text, format: cFormat, status: cStatus, dryRun } : { payload: JSON.parse(cf.text), format: cFormat, status: cStatus, dryRun };
      const d = await post<{ data: CommentPlan }>('/api/admin/backup/comments', body);
      cPlan = d.data;
      if (!dryRun) {
        notice = `评论导入完成：写入 ${d.data.applied?.inserted ?? 0} 条`;
        cf = null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : '评论导入失败';
    } finally {
      busy = '';
    }
  }

  $effect(() => void load());
</script>

<div class="row spread head">
  <h2>备份</h2>
  <div class="row">
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新列表'}</button>
  </div>
</div>

<p class="muted small">备份包含 D1 里的动态数据（评论、订阅、用户、统计、配置等），不含 Git 里的文章内容。</p>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

<section class="card">
  <h3>导出</h3>
  <div class="row opts">
    <label>
      范围
      <select bind:value={scope}>
        <option value="core">核心（配置、评论、用户、订阅、友链申请）</option>
        <option value="full">全量（含统计、邮件日志、审计留痕）</option>
      </select>
    </label>
    <label class="switch">
      <input type="checkbox" bind:checked={withSecrets} />
      <span>存档包含明文密钥配置</span>
    </label>
  </div>
  <div class="row actions">
    <button onclick={() => void download()} disabled={busy !== ''}>导出到本地</button>
    <button class="primary" onclick={() => void archive()} disabled={busy !== ''}>
      {busy === 'archive' ? '存档中…' : '存档到 R2'}
    </button>
  </div>
  {#if withSecrets}
    <p class="warn small">含密钥的备份文件等于一份登录凭证，只放在自己的加密盘里。</p>
  {/if}

  {#if lastExport}
    <div class="counts">
      {#each Object.entries(lastExport.counts) as [name, n] (name)}
        <span class="pill">{name} {n}</span>
      {/each}
    </div>
    {#each lastExport.warnings as w (w)}
      <p class="warn small">{w}</p>
    {/each}
  {/if}
</section>

<section class="card">
  <h3>R2 里的存档</h3>
  {#if objects.length === 0}
    <p class="muted small">还没有存档。</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>文件</th><th>大小</th><th>时间</th><th></th></tr>
        </thead>
        <tbody>
          {#each objects as o (o.key)}
            <tr>
              <td class="mono">{o.key}</td>
              <td>{kb(o.size)}</td>
              <td>{o.uploaded ? fmtDate(Math.floor(new Date(o.uploaded).getTime() / 1000)) : '—'}</td>
              <td class="ops">
                <button class="sm" onclick={() => void downloadKey(o.key)}>下载</button>
                <button class="sm danger" onclick={() => void removeObject(o)} disabled={busy === o.key}>删除</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<section class="card">
  <h3>导入</h3>
  <p class="muted small">先做演习，只统计各表会写多少行，不落库；确认后再真写。相同主键的行会被跳过，不会覆盖现有数据。</p>
  <input type="file" accept="application/json,.json" onchange={(e) => void pickFile(e.currentTarget.files?.[0])} />

  {#if picked}
    <div class="meta">
      <p class="small">{picked.name} · 导出于 {fmtDate(picked.payload.createdAt)} · 站点 {picked.payload.siteName} · 备份格式 v{picked.payload.version}</p>
      <div class="counts">
        {#each Object.entries(picked.payload.counts) as [name, n] (name)}
          <span class="pill">{name} {n}</span>
        {/each}
      </div>
      <div class="row actions">
        <button onclick={() => void runImport(true)} disabled={busy !== ''}>{busy === 'dry' ? '演习中…' : '先跑演习'}</button>
        <button class="danger" onclick={() => void runImport(false)} disabled={busy !== '' || !outcome?.dryRun}>
          {busy === 'apply' ? '导入中…' : '确认导入'}
        </button>
        <button class="ghost" onclick={() => { picked = null; outcome = null; }}>取消</button>
      </div>
      {#if !outcome?.dryRun}<p class="muted small">必须先看一次演习结果，才允许真写。</p>{/if}
    </div>
  {/if}

  {#if outcome}
    <div class="card inner">
      <h4>{outcome.dryRun ? '演习结果' : '导入结果'}</h4>
      <div class="table-wrap">
        <table class="cols-wide">
          <thead>
            <tr><th>表</th><th>备份行数</th><th>将写入</th><th>跳过</th><th>说明</th></tr>
          </thead>
          <tbody>
            {#each outcome.tables as t (t.name)}
              <tr>
                <td>{t.name}</td>
                <td>{t.rows}</td>
                <td>{t.inserted}</td>
                <td>{t.skipped}</td>
                <td class="muted">{t.note || '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#each outcome.errors as msg (msg)}<p class="err small">{msg}</p>{/each}
    </div>
  {/if}
</section>

<section class="card">
  <h3>导入其它评论系统的历史评论</h3>
  <p class="muted small">
    支持 <strong>Waline / Twikoo / Artalk / Giscus / CommentBox</strong> 的导出文件（JSON 或 CSV），
    以及自家备份文件里的 comments 段。字段名各家都不一样，后端按候选键名依次取值；
    先「先跑演习」看清识别结果、条数与落到的文章，再点「确认写入」。
    写入的每条都带「历史数据」标记与原始 id，<strong>重复导入同一份文件不会翻倍</strong>。
  </p>

  <div class="row fields">
    <input type="file" accept="application/json,.json,.csv,text/csv" onchange={(e) => void pickCommentFile(e.currentTarget.files?.[0])} />
    <label class="inline">
      来源格式
      <select bind:value={cFormat}>
        {#each FORMATS as [v, label] (v)}
          <option value={v}>{label}</option>
        {/each}
      </select>
    </label>
    <label class="inline">
      入库状态
      <select bind:value={cStatus}>
        <option value="keep">按文件里的状态</option>
        <option value="approved">全部直接显示</option>
        <option value="pending">全部先进待审</option>
      </select>
    </label>
  </div>

  {#if cf}
    <p class="small">
      已选文件：{cf.name} · 解析为 {cf.kind === 'csv' ? 'CSV 表格' : 'JSON'} ·
      {cFormat ? FORMATS.find((f) => f[0] === cFormat)?.[1] : '自动识别'}
    </p>
    <div class="row actions">
      <button onclick={() => void runCommentImport(true)} disabled={busy !== ''}>{busy === 'cdry' ? '演习中…' : '先跑演习'}</button>
      <button class="danger" onclick={() => void runCommentImport(false)} disabled={busy !== '' || !cPlan?.dryRun}>
        {busy === 'capply' ? '写入中…' : '确认写入'}
      </button>
      <button class="ghost" onclick={() => { cf = null; cPlan = null; }}>取消</button>
    </div>
    {#if !cPlan?.dryRun}<p class="muted small">必须先看一次演习结果，才允许真写。</p>{/if}
  {/if}

  {#if cPlan}
    <div class="card inner">
      <h4>{cPlan.dryRun ? '演习结果' : '写入结果'}</h4>
      <p class="small">{cPlan.summary}</p>
      <p class="muted small">
        文件里一共 {cPlan.total} 条，可入库 {cPlan.rows} 条{#if cPlan.applied}，本次实际写入 {cPlan.applied.inserted} 条{/if}。
      </p>
      {#if cPlan.skipped?.length}
        <ul class="tight">
          {#each cPlan.skipped as s (s.reason)}
            <li class="muted small">{s.reason}：{s.count} 条</li>
          {/each}
        </ul>
      {/if}
      {#if cPlan.slugs?.length}
        <p class="muted small">会落到这些文章地址上（最多列 30 个，对不上就说明导出里的路径与本站 permalink 不同，先在「评论」页核对一篇再写入）：</p>
        <div class="counts">
          {#each cPlan.slugs as s (s.slug)}
            <span class="pill">{s.slug} {s.count}</span>
          {/each}
        </div>
      {/if}
      {#if cPlan.notice}<p class="muted small">提示：{cPlan.notice}</p>{/if}
    </div>
  {/if}
</section>

<style>
  .head {
    margin-bottom: 0.5rem;
  }
  .small {
    font-size: 0.76rem;
  }
  section.card + section.card {
    margin-top: 0.8rem;
  }
  .opts {
    margin: 0.5rem 0;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem;
    align-items: flex-end;
  }

  .inline {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.8rem;
  }

  .tight {
    margin: 0.2rem 0 0.4rem;
    padding-left: 1.1rem;
  }

  .actions {
    margin-top: 0.6rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    color: var(--fg);
    font-size: 0.85rem;
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.7rem;
  }
  .pill {
    font-size: 0.75rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    padding: 0.08rem 0.55rem;
  }
  .mono {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.8rem;
  }
  .ops {
    white-space: nowrap;
  }
  .ops button + button {
    margin-left: 0.3rem;
  }
  .meta {
    margin-top: 0.7rem;
  }
  .inner {
    margin-top: 0.8rem;
    background: #fafafa;
  }
  .inner h4 {
    margin: 0 0 0.5rem;
    font-size: 0.86rem;
  }
</style>
