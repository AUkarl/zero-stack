<script lang="ts">
  import { del, get, getApiBase, post } from '#lib/api';
  import { fmtDate } from '#lib/api';

  /**
   * 全站备份：导出一份 JSON，恢复时按分区勾选。
   *
   * 旧版的「范围：核心 / 全量」两档、「存档包含明文密钥」开关，
   * 以及「统计与邮件日志只取最近 N 条」的截断都删了 ——
   * 备份只有一种（全站），密钥永不进文件，被备份的表一律整表；要挑就挑分区，不再挑范围。
   */

  interface BackupFile {
    path: string;
    content: string;
  }
  interface MediaObject {
    key: string;
    size: number;
    uploaded: string | null;
    usedBy: string[];
  }
  interface Section {
    id: string;
    counts: Record<string, number>;
    tables?: Record<string, unknown[]>;
    files?: BackupFile[];
    objects?: MediaObject[];
    notes?: string[];
  }
  interface Payload {
    version: number;
    createdAt: number;
    siteName: string;
    note: string;
    origin: {
      owner: string;
      repo: string;
      branch: string;
      siteUrl: string;
      dataDir: string;
      postsDir: string;
      momentsDir: string;
      linksFile: string;
      authorsFile: string;
    };
    omitted: { key: string; reason: string; value: string }[];
    sections: Section[];
  }
  interface OutcomeSection {
    id: string;
    label: string;
    files?: { total: number; write: number; skip: number; unchanged: number; conflicts: string[] };
    tables?: { name: string; rows: number; inserted: number; skipped: number; note: string | null }[];
    settings?: { write: number; changed: { key: string; from: string; to: string }[] };
    media?: { total: number; present: number; absent: number };
    notes: string[];
    errors: string[];
  }
  interface Outcome {
    dryRun: boolean;
    overwrite: boolean;
    source: { version: number; createdAt: number; siteName: string; origin: Payload['origin'] };
    layout: { postsDir: { from: string; to: string }; momentsDir: { from: string; to: string }; dataDir: { from: string; to: string } };
    sections: OutcomeSection[];
    build: { triggered: boolean; error?: string } | null;
  }
  interface CatalogItem {
    id: string;
    label: string;
    what: string;
  }
  interface StoredObject {
    key: string;
    size: number;
    uploaded: string | null;
  }
  interface ArchiveResult {
    key: string;
    pruned: number;
    siteName: string;
    omitted: number;
    warnings: string[];
    sections: { id: string; counts: Record<string, number>; notes: string[] }[];
  }

  let catalog = $state<CatalogItem[]>([]);
  let objects = $state<StoredObject[]>([]);
  let loading = $state(false);
  let busy = $state('');
  let error = $state('');
  let notice = $state('');
  let lastExport = $state<ArchiveResult | null>(null);

  let picked = $state<{ name: string; payload: Payload } | null>(null);
  /** 勾选要恢复的分区：默认全选，但可以只挑「文章」或只挑「评论」 */
  let chosen = $state<Set<string>>(new Set());
  let overwrite = $state(false);
  let outcome = $state<Outcome | null>(null);

  /* ---------------- 图片包：本体也走后台，迁站不用碰命令行 ---------------- */

  interface PackItem {
    key: string;
    bucket: string;
    contentType: string;
    size: number;
    /** base64：一张一张传，绕开 Worker 单次请求的体积上限 */
    bytes: string;
  }
  interface MediaPack {
    kind: 'zero-media-pack';
    version: number;
    generatedAt: string;
    items: PackItem[];
  }
  interface PackResult {
    written: number;
    skipped: string[];
    failed: string[];
  }
  interface MediaListOut {
    data: { objects: { key: string; size: number }[]; truncated: boolean; cursor: string | null };
  }

  let packBusy = $state('');
  let packProgress = $state('');
  let packOut = $state<PackResult | null>(null);
  /** 清单里列出了、取的时候却没了的对象 */
  let packWarn = $state<string[]>([]);
  /** 选好的图片包，还没写 */
  let pending = $state<MediaPack | null>(null);

  async function load() {
    loading = true;
    try {
      const [list, cat] = await Promise.all([
        get<{ data: StoredObject[] }>('/api/admin/backup/list'),
        get<{ data: { sections: CatalogItem[] } }>('/api/admin/backup/catalog'),
      ]);
      objects = list.data;
      catalog = cat.data.sections;
    } catch (e) {
      error = e instanceof Error ? e.message : '备份列表读取失败';
    } finally {
      loading = false;
    }
  }

  const labelOf = (id: string) => catalog.find((c) => c.id === id)?.label ?? id;

  /** 分区里到底有什么：把后端给的中文计数键拼成一句人话 */
  function summaryOf(s: { counts: Record<string, number>; files?: unknown[]; objects?: unknown[] }): string {
    const parts = Object.entries(s.counts ?? {}).map(([k, v]) => `${k} ${v}`);
    if (parts.length) return parts.join(' · ');
    const n = (s.files?.length ?? 0) + (s.objects?.length ?? 0);
    return n ? `${n} 项` : '空';
  }

  function saveAs(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 导出到浏览器。必须走 #lib/api：Pages 部署没有 /api 代理，手写相对地址会打到 SPA 自己 */
  async function download() {
    busy = 'download';
    error = '';
    try {
      const payload = await get<Payload>('/api/admin/backup/export');
      saveAs(`zero-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
      notice = `已导出全站备份：${payload.sections.length} 个分区；未写回的绑定项与密钥 ${payload.omitted.length} 条只列在文件里供人工对照`;
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
      const d = await get<{ data: ArchiveResult }>('/api/admin/backup/export?save=1');
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
      const payload = await get<Payload>(`/api/admin/backup/file?key=${encodeURIComponent(key)}`);
      saveAs(key.split('/').pop() ?? 'backup.json', JSON.stringify(payload, null, 2));
    } catch (e) {
      error = e instanceof Error ? e.message : '取回失败';
    }
  }

  async function removeObject(o: StoredObject) {
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

  /** 走后台代理取原图：私有桶没有直链，只有 Worker 读得到 */
  async function fetchObjectBytes(bucketId: string, key: string): Promise<{ buf: ArrayBuffer; type: string } | null> {
    const path = `/api/admin/media/${key.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(`${getApiBase()}${path}?bucket=${encodeURIComponent(bucketId)}`, { credentials: 'include' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`取回 ${key} 失败（${res.status}）`);
    return { buf: await res.arrayBuffer(), type: res.headers.get('Content-Type') ?? 'application/octet-stream' };
  }

  function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let s = '';
    /** 一次把几百万个字节展开成 fromCharCode 的参数会打爆调用栈，每 32KB 切一段 */
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 一份包最多带多少个对象：再多就该分批导，浏览器整份握在内存里会先卡死 */
  const PACK_MAX = 2000;

  async function exportPack() {
    packBusy = 'export';
    packOut = null;
    packWarn = [];
    error = '';
    try {
      const buckets = await get<{ data: { id: string }[] }>('/api/admin/media/buckets');
      const items: PackItem[] = [];
      let seen = 0;
      for (const b of buckets.data) {
        let next: string | null = null;
        do {
          const qs = new URLSearchParams({ bucket: b.id, prefix: 'uploads/', limit: '1000' });
          if (next) qs.set('cursor', next);
          const r = await get<MediaListOut>('/api/admin/media/list?' + qs.toString());
          for (const o of r.data.objects) {
            if (items.length >= PACK_MAX) throw new Error(`对象超过 ${PACK_MAX} 个：一份包装不下，请在「媒体库」按目录分批导出`);
            const got = await fetchObjectBytes(b.id, o.key);
            seen++;
            if (!got) {
              packWarn.push(`${o.key}（桶里列出来了，取的时候却没了）`);
              continue;
            }
            items.push({ key: o.key, bucket: b.id, contentType: got.type, size: o.size, bytes: toBase64(got.buf) });
            packProgress = `已取 ${seen} 个对象，包内 ${items.length} 张`;
          }
          next = r.data.truncated ? r.data.cursor : null;
        } while (next);
      }
      const pack: MediaPack = { kind: 'zero-media-pack', version: 1, generatedAt: new Date().toISOString(), items };
      saveAs(`zero-media-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(pack));
      notice = `图片包已导出：${items.length} 张${packWarn.length ? `，有 ${packWarn.length} 个对象没取到` : ''}`;
    } catch (e) {
      error = e instanceof Error ? e.message : '图片包导出失败';
    } finally {
      packBusy = '';
      packProgress = '';
    }
  }

  async function pickPackFile(file: File | undefined) {
    if (!file) return;
    error = '';
    packOut = null;
    pending = null;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<MediaPack>;
      if (parsed?.kind !== 'zero-media-pack' || !Array.isArray(parsed.items)) throw new Error('这不是图片包：文件里没有 zero-media-pack 标记或 items 列表');
      const usable = parsed.items.filter((it) => typeof it?.key === 'string' && typeof it?.bytes === 'string');
      if (!usable.length) throw new Error('包里的条目都缺 key 或图片数据，一张可用的都没有');
      pending = { ...(parsed as MediaPack), items: usable };
      const mb = usable.reduce((n, it) => n + (Number(it.size) || 0), 0) / 1024 / 1024;
      notice = `图片包已载入：${usable.length} 张 · 约 ${mb.toFixed(1)} MB${usable.length < parsed.items.length ? `（另有 ${parsed.items.length - usable.length} 条读不出，会跳过）` : ''}。本站已有同名的直接跳过，不会盖掉。`;
    } catch (e) {
      error = e instanceof Error ? e.message : '图片包解析失败';
      pending = null;
    }
  }

  /** 一张一个请求：单次请求只搬一张图，Worker 的体积上限就卡不住整站图片 */
  async function importPack() {
    if (!pending) return;
    packBusy = 'import';
    error = '';
    packOut = null;
    const list = pending.items;
    const skipped: string[] = [];
    const failed: string[] = [];
    let written = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i]!;
      packProgress = `第 ${i + 1} / ${list.length} 张：${it.key}`;
      try {
        const fd = new FormData();
        fd.set('file', new File([fromBase64(it.bytes)], it.key.split('/').pop() || 'file', { type: it.contentType || 'application/octet-stream' }));
        fd.set('key', it.key);
        fd.set('bucket', it.bucket);
        const res = await fetch(`${getApiBase()}/api/admin/media/import`, { method: 'POST', credentials: 'include', body: fd });
        const body = (await res.json().catch(() => null)) as { data?: { skipped?: boolean }; message?: string } | null;
        if (!res.ok) {
          failed.push(`${it.key}：${body?.message || `请求失败 (${res.status})`}`);
          continue;
        }
        if (body?.data?.skipped) skipped.push(it.key);
        else written++;
      } catch (e) {
        failed.push(`${it.key}：${e instanceof Error ? e.message : '网络失败'}`);
      }
    }
    packOut = { written, skipped, failed };
    pending = null;
    packBusy = '';
    packProgress = '';
    notice = `图片写完：新存 ${written} 张 · 同名跳过 ${skipped.length} 张 · 失败 ${failed.length} 张`;
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    error = '';
    outcome = null;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Payload> & { tables?: unknown; scope?: string };
      if (!parsed || typeof parsed !== 'object') throw new Error('这个文件不是 JSON 对象');
      if (!Array.isArray(parsed.sections)) {
        throw new Error(
          parsed.tables
            ? '这是旧版（v1）备份：只有数据表，没有文章、时刻与主题样式。评论可以走下面「导入其它评论系统的历史评论」，其余内容请用新版重新导一份'
            : '这不是全站备份文件（缺少 sections 分区）',
        );
      }
      picked = { name: file.name, payload: parsed as Payload };
      chosen = new Set((parsed as Payload).sections.map((s) => s.id));
    } catch (e) {
      error = e instanceof Error ? e.message : '文件解析失败';
      picked = null;
      chosen = new Set();
    }
  }

  function pickAll(on: boolean) {
    chosen = new Set(on ? (picked?.payload.sections ?? []).map((s) => s.id) : []);
    outcome = null;
  }

  function toggle(id: string) {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    chosen = next;
    // 勾选一变，上一份演习结果就不再对应这次的组合
    outcome = null;
  }

  /** 恢复分两步：先按勾选的分区演习，看清影响面再真写 */
  async function runImport(dryRun: boolean) {
    if (!picked) return;
    if (!chosen.size) {
      error = '至少要勾一个分区';
      return;
    }
    busy = dryRun ? 'dry' : 'apply';
    error = '';
    if (!dryRun) {
      if (!outcome?.dryRun) {
        error = '必须先看一次演习结果，才允许真写';
        busy = '';
        return;
      }
      const names = [...chosen].map(labelOf).join('、');
      if (
        !confirm(
          `确认恢复这 ${chosen.size} 个分区：${names}\n\n` +
            (overwrite ? '同名文件会被备份内容覆盖。' : '同名文件不会被覆盖（本站已有的保持不动）。') +
            '\n\n这一步会写数据库并提交到内容仓库。',
        )
      ) {
        busy = '';
        return;
      }
    }
    try {
      const d = await post<{ data: Outcome }>('/api/admin/backup/import', {
        payload: picked.payload,
        sections: [...chosen],
        dryRun,
        overwrite,
      });
      outcome = d.data;
      if (!dryRun) {
        const rows = d.data.sections.reduce((n, s) => n + (s.tables?.reduce((m, t) => m + t.inserted, 0) ?? 0), 0);
        const files = d.data.sections.reduce((n, s) => n + (s.files?.write ?? 0), 0);
        notice = `恢复完成：数据表新增 ${rows} 行、仓库写入 ${files} 个文件${d.data.build?.triggered ? '，已触发站点重建' : ''}`;
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
    /** Waline / CommentBox 的附属计数：按只增不减并进来 */
    counters?: { slugs: number; likesAdded: number; viewsAdded: number; kept: number };
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
  /** Giscus 这类按页导出的文件里不带文章地址，导入时由这里补 */
  let cSlug = $state('');
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
      if (!isCsv) {
        kind = 'json';
        // 先在本机解一次 JSON：文件坏了当场就说，不必等后端回 400
        JSON.parse(text);
      }
      cf = { name: file.name, kind, text };
    } catch (e) {
      error = e instanceof Error ? e.message : '文件读取失败';
      cf = null;
    }
  }

  /** 与分区恢复一样：先演习看清影响面，确认后才真写 */
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
      const extra = { format: cFormat, status: cStatus, defaultSlug: cSlug.trim() || undefined, dryRun };
      const body = cf.kind === 'csv' ? { csv: cf.text, ...extra } : { payload: JSON.parse(cf.text), ...extra };
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

<p class="muted small">
  只有一种备份：全站。一份文件带主题样式、文章、时刻、评论、点赞与收藏、友链、订阅名单、普通用户、站点设置与媒体清单。
  <strong>导出不挑范围，恢复时才挑分区</strong> —— 每个分区可以单独演习、单独推送，不会一把全盖回去。
</p>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

<section class="card">
  <h3>这份备份里有什么</h3>
  <div class="table-wrap">
    <table>
      <tbody>
        {#each catalog as c (c.id)}
          <tr>
            <td class="w"><strong>{c.label}</strong></td>
            <td class="muted small">{c.what}</td>
          </tr>
        {:else}
          <tr><td class="muted small" colspan="2">分区目录读取中…</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="muted small">
    不进备份：邮件发送日志、群发任务、邀请码使用记录、访问统计明细、审计流水、登录会话与第三方绑定。
    密钥（SMTP 密码、各家 API Key）永不进文件；绑定本站域名与仓库坐标的配置项也不会写回新站，
    只在文件里列出旧值给你人工对照。图片本体不在文件里，用下面「图片（媒体本体）」那一节单独导一个图片包过去。
  </p>

  <div class="row actions">
    <button onclick={() => void download()} disabled={busy !== ''}>{busy === 'download' ? '导出中…' : '导出到本地'}</button>
    <button class="primary" onclick={() => void archive()} disabled={busy !== ''}>
      {busy === 'archive' ? '存档中…' : '存档到 R2'}
    </button>
  </div>

  {#if lastExport}
    <div class="meta">
      <p class="small">
        最近一次存档：{lastExport.key} · 站点 {lastExport.siteName || '（未记名）'} · 没带的绑定项与密钥 {lastExport.omitted} 条
      </p>
      <div class="counts">
        {#each lastExport.sections as s (s.id)}
          <span class="pill">{labelOf(s.id)} {summaryOf(s)}</span>
        {/each}
      </div>
      {#each lastExport.warnings as w (w)}
        <p class="muted small">提示：{w}</p>
      {/each}
    </div>
  {/if}
</section>

<section class="card">
  <h3>R2 里的存档</h3>
  {#if loading && !objects.length}
    <p class="muted small">读取中…</p>
  {:else if !objects.length}
    <p class="muted small">还没有存档。上面点「存档到 R2」，本站最多保留最近 10 份。</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>文件</th><th>体积</th><th>时间</th><th></th></tr>
        </thead>
        <tbody>
          {#each objects as o (o.key)}
            <tr>
              <td class="mono">{o.key}</td>
              <td>{kb(o.size)}</td>
              <td class="muted">{o.uploaded ? fmtDate(Math.floor(new Date(o.uploaded).getTime() / 1000)) : '—'}</td>
              <td class="ops">
                <button class="sm" onclick={() => void downloadKey(o.key)}>取回</button>
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
  <h3>图片（媒体本体）</h3>
  <p class="muted small">
    上面那份全站备份里只有图片<strong>清单</strong>，图片本体在这一节搬：导出一个「图片包」，
    到新站的同一节导入。一张一个请求走后台代理，单次请求的体积上限卡不住整站图片；
    写回用的是<strong>原对象键</strong>，所以文章与主题里已有的图片地址不会变。
    本站已经有同名的就跳过 —— 恢复不该把新站这段时间刚传的图打回旧版。
  </p>
  <div class="row actions">
    <button onclick={() => void exportPack()} disabled={packBusy !== '' || busy !== ''}>
      {packBusy === 'export' ? '打包中…' : '导出图片包'}
    </button>
  </div>
  {#if packWarn.length}
    <details>
      <summary class="muted small">有 {packWarn.length} 个对象没取到</summary>
      <ul class="tight">
        {#each packWarn as w (w)}
          <li class="small mono">{w}</li>
        {/each}
      </ul>
    </details>
  {/if}

  <input type="file" accept="application/json,.json" onchange={(e) => void pickPackFile(e.currentTarget.files?.[0])} />
  {#if pending}
    <div class="row actions">
      <button class="danger" onclick={() => void importPack()} disabled={packBusy !== '' || busy !== ''}>
        {packBusy === 'import' ? '写入中…' : `逐张写入（共 ${pending.items.length} 张，同名跳过）`}
      </button>
      <button class="ghost" onclick={() => { pending = null; packOut = null; }} disabled={packBusy !== ''}>取消</button>
    </div>
  {:else if packBusy !== 'import'}
    <p class="muted small">还没选文件：挑一份上面「导出图片包」存下来的 .json。</p>
  {/if}
  {#if packProgress}
    <p class="muted small">{packProgress}</p>
  {/if}
  {#if packOut}
    <div class="counts">
      <span class="pill">新写入 {packOut.written}</span>
      <span class="pill">同名跳过 {packOut.skipped.length}</span>
      <span class="pill" class:bad={packOut.failed.length > 0}>失败 {packOut.failed.length}</span>
    </div>
    {#if packOut.skipped.length}
      <details>
        <summary class="muted small">跳过的 {packOut.skipped.length} 张（本站已有同名对象，没覆盖）</summary>
        <ul class="tight">
          {#each packOut.skipped as k (k)}
            <li class="small mono">{k}</li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if packOut.failed.length}
      <details>
        <summary class="muted small">失败的 {packOut.failed.length} 张</summary>
        <ul class="tight">
          {#each packOut.failed as f (f)}
            <li class="small mono">{f}</li>
          {/each}
        </ul>
      </details>
    {/if}
    <p class="muted small">回上面「媒体清单」再跑一次恢复演习，缺的数量就会对上。</p>
  {/if}
</section>

<section class="card">
  <h3>恢复</h3>
  <p class="muted small">
    选一份备份文件，下面会列出它带的分区与各自条数。勾选要恢复的分区，先「跑演习」——
    演习不写任何东西，只告诉你每区会写多少行、哪些文件同名、配置要改哪几项；确认过再「推送恢复」。
    改动勾选后上一份演习结果就作废，需要重跑一次。
  </p>
  <input type="file" accept="application/json,.json" onchange={(e) => void pickFile(e.currentTarget.files?.[0])} />

  {#if picked}
    <div class="meta">
      <p class="small">
        {picked.name} · 导出于 {fmtDate(picked.payload.createdAt)} · 来源站点 {picked.payload.siteName || '（未记名）'} · 格式 v{picked.payload.version}
      </p>
      <p class="muted small">
        来源仓库 {picked.payload.origin.owner || '（未记）'}/{picked.payload.origin.repo || '（未记）'}@{picked.payload.origin.branch || 'main'} ·
        备份里的目录：文章 {picked.payload.origin.postsDir} · 时刻 {picked.payload.origin.momentsDir} · 数据 {picked.payload.origin.dataDir}。
        文件按备份里的相对路径写回本站仓库，所以本站「设置 → 内容仓库」的目录要和它一致，否则内容会落到另一个位置。
      </p>

      <div class="row actions">
        <button class="sm" onclick={() => pickAll(true)}>全选</button>
        <button class="sm ghost" onclick={() => pickAll(false)}>都不选</button>
        <label class="switch">
          <input type="checkbox" bind:checked={overwrite} />
          <span>覆盖同名文件（默认不覆盖：本站仓库里已有且内容不同的文件保持不动）</span>
        </label>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr><th></th><th>分区</th><th>内容</th></tr>
          </thead>
          <tbody>
            {#each picked.payload.sections as s (s.id)}
              <tr class={chosen.has(s.id) ? '' : 'dim'}>
                <td><input type="checkbox" checked={chosen.has(s.id)} onchange={() => toggle(s.id)} /></td>
                <td class="w">{labelOf(s.id)}</td>
                <td class="muted small">
                  {summaryOf(s)}
                  {#if s.notes?.length}
                    <div>{s.notes.join('；')}</div>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if picked.payload.omitted?.length}
        <details>
          <summary class="muted small">这份文件没带的 {picked.payload.omitted.length} 项配置（密钥不进文件；绑定本站的项不写回）</summary>
          <ul class="tight">
            {#each picked.payload.omitted as o (o.key)}
              <li class="small"><code>{o.key}</code> — {o.reason}{#if o.value}（旧值 {o.value}）{/if}</li>
            {/each}
          </ul>
        </details>
      {/if}

      <div class="row actions">
        <button onclick={() => void runImport(true)} disabled={busy !== '' || !chosen.size}>{busy === 'dry' ? '演习中…' : '跑演习'}</button>
        <button class="danger" onclick={() => void runImport(false)} disabled={busy !== '' || !chosen.size || !outcome?.dryRun}>
          {busy === 'apply' ? '恢复中…' : `推送恢复（已勾 ${chosen.size} 区）`}
        </button>
        <button class="ghost" onclick={() => { picked = null; outcome = null; chosen = new Set(); }}>取消</button>
      </div>
      {#if !outcome?.dryRun && chosen.size}<p class="muted small">先看一次演习，才允许真写。</p>{/if}
    </div>
  {/if}

  {#if outcome}
    <div class="card inner">
      <h4>{outcome.dryRun ? '演习结果（还没写任何东西）' : '恢复结果'}</h4>
      {#each outcome.sections as s (s.id)}
        <div class="srow">
          <div class="shead">
            <strong>{s.label || labelOf(s.id)}</strong>
            {#if s.files}
              <span class="muted small">文件 {s.files.total}：要写 {s.files.write} · 跳过 {s.files.skip} · 内容相同 {s.files.unchanged}</span>
            {/if}
            {#if s.settings}
              <span class="muted small">配置要改 {s.settings.write} 项</span>
            {/if}
            {#if s.media}
              <span class="muted small">媒体清单 {s.media.total} 个：本站已有 {s.media.present} · 缺 {s.media.absent}</span>
            {/if}
          </div>
          {#if s.tables?.length}
            <div class="counts">
              {#each s.tables as t (t.name)}
                <span class="pill" class:bad={Boolean(t.note?.startsWith('写入出错'))}>
                  {t.name} {t.rows} 行 → 写 {t.inserted} · 跳 {t.skipped}{t.note ? `（${t.note}）` : ''}
                </span>
              {/each}
            </div>
          {/if}
          {#if s.settings?.changed?.length}
            <details>
              <summary class="muted small">本站现值 → 备份值（{s.settings.changed.length} 项）</summary>
              <ul class="tight">
                {#each s.settings.changed as c (c.key)}
                  <li class="small"><code>{c.key}</code>：<span class="mono">{c.from || '（空）'}</span> → <span class="mono">{c.to || '（空）'}</span></li>
                {/each}
              </ul>
            </details>
          {/if}
          {#if s.files?.conflicts?.length}
            <details>
              <summary class="muted small">同名文件 {s.files.conflicts.length} 个{overwrite ? '（已勾覆盖，会被备份内容替换）' : '（没勾覆盖，保持本站不动）'}</summary>
              <ul class="tight">
                {#each s.files.conflicts as p (p)}
                  <li class="small mono">{p}</li>
                {/each}
              </ul>
            </details>
          {/if}
          {#each s.notes as n (n)}
            <p class="muted small">{n}</p>
          {/each}
          {#each s.errors as e (e)}
            <p class="err small">{e}</p>
          {/each}
        </div>
      {/each}
      {#if outcome.build}
        <p class="small">
          站点重建：{outcome.build.triggered ? '已触发 Pages 构建，几分钟后前端更新' : `没自动触发（${outcome.build.error ?? '未配置构建 Hook'}）—— 去 Pages 等下一次自动构建，或手动 Trigger`}
        </p>
      {/if}
    </div>
  {/if}
</section>

<section class="card">
  <h3>导入其它评论系统的历史评论</h3>
  <p class="muted small">
    支持 <strong>Waline / Twikoo / Artalk / Giscus / CommentBox</strong> 的导出文件（JSON 或 CSV），
    以及自家备份文件里的 comments 段。字段名各家都不一样，后端按候选键名依次取值；
    先「跑演习」看清识别结果、条数与落到的文章，再点「确认写入」。
    写入的每条都带「历史数据」标记与原始 id，<strong>重复导入同一份文件不会翻倍</strong>。
    Waline 附带那张 Counter（点赞数 / 浏览量）按<strong>只增不减</strong>并入：本站更大的时候保持本站，不会被旧站的数盖掉。
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
    <label class="inline">
      文章地址兜底
      <input bind:value={cSlug} placeholder="/posts/xxx/" title="Giscus 这类按页导出的文件每行都不带文章地址，填了就用它；文件里本来就有的行不受影响" />
    </label>
  </div>

  {#if cf}
    <p class="small">
      已选文件：{cf.name} · 解析为 {cf.kind === 'csv' ? 'CSV 表格' : 'JSON'} ·
      {cFormat ? FORMATS.find((f) => f[0] === cFormat)?.[1] : '自动识别'}
    </p>
    <div class="row actions">
      <button onclick={() => void runCommentImport(true)} disabled={busy !== ''}>{busy === 'cdry' ? '演习中…' : '跑演习'}</button>
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
      {#if cPlan.counters}
        <p class="muted small">
          附属计数：涉及 {cPlan.counters.slugs} 个地址，点赞补 {cPlan.counters.likesAdded}、浏览补 {cPlan.counters.viewsAdded}，本站已经更大的 {cPlan.counters.kept} 个保持不动。
        </p>
      {/if}
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
    align-items: center;
  }
  .switch {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    color: var(--fg);
    font-size: 0.8rem;
    margin-left: 0.6rem;
  }
  .w {
    width: 8.5rem;
  }
  .dim td {
    opacity: 0.45;
  }
  .srow {
    padding: 0.55rem 0;
    border-top: 1px solid var(--line, #eee);
  }
  .srow:first-child {
    border-top: 0;
    padding-top: 0;
  }
  .shead {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.5rem;
  }
  .pill {
    font-size: 0.75rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    padding: 0.08rem 0.55rem;
  }
  .pill.bad {
    background: #fdecec;
    color: #b3261e;
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
