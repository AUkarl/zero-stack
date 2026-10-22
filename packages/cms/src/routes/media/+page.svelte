<script lang="ts">
  import { del, get, getApiBase, patch } from '#lib/api';
  import { compressNote, prepareImage } from '#lib/image-compress';
  import { loadMediaBases, mediaLink, mediaLinkKind } from '#lib/media-url.svelte';

  interface MediaItem {
    key: string;
    size: number;
    uploaded: number;
  }

  interface Bucket {
    id: string;
    label: string;
    kind: 'r2' | 's3';
    binding?: string;
    bucket?: string;
    endpoint?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    baseUrl?: string;
    prefix?: string;
    /** 缺省 true（= 现有行为）：显式存成 false 才拒绝匿名走 /api/media/<id>/<键> 读 */
    publicRead?: boolean;
  }

  interface Row {
    __k: string;
    id: string;
    label: string;
    kind: 'r2' | 's3';
    binding: string;
    bucket: string;
    endpoint: string;
    region: string;
    baseUrl: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicRead: boolean;
  }

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  let items = $state<MediaItem[]>([]);
  let uploading = $state(false);
  let progress = $state('');
  let error = $state('');
  let filter = $state('');
  let input: HTMLInputElement;

  let buckets = $state<Bucket[]>([]);
  let selectedId = $state('');
  let bucketsFromApi = $state(true);

  const selected = $derived(buckets.find((b) => b.id === selectedId) ?? null);
  const linkKind = $derived(mediaLinkKind(selected));

  // 管理抽屉
  let drawer = $state(false);
  let rows = $state<Row[]>([]);
  let secretByK = $state<Record<string, { accessKeyId: string; secretAccessKey: string }>>({});
  let draftSaving = $state(false);
  let draftError = $state('');
  let draftNotice = $state('');

  function normalize(raw: unknown): Bucket[] {
    const arr = Array.isArray(raw) ? raw : [];
    return (arr as Partial<Bucket>[]).map((b, i) => ({
      id: String(b?.id ?? `bucket-${i}`),
      label: String(b?.label ?? b?.id ?? `存储桶 ${i + 1}`),
      kind: b?.kind === 's3' ? 's3' : 'r2',
      binding: b?.binding ?? '',
      bucket: b?.bucket ?? '',
      endpoint: b?.endpoint ?? '',
      region: b?.region ?? '',
      accessKeyId: b?.accessKeyId ?? '',
      secretAccessKey: b?.secretAccessKey ?? '',
      baseUrl: b?.baseUrl ?? '',
      prefix: b?.prefix ?? '',
      publicRead: b?.publicRead !== false,
    }));
  }

  async function loadBuckets() {
    error = '';
    // 优先读专用接口；缺失时退回配置键 mediaBuckets（同一份数据源）
    try {
      const d = await get<{ data: unknown }>('/api/admin/media/buckets');
      buckets = normalize(d.data);
      bucketsFromApi = true;
    } catch {
      bucketsFromApi = false;
      try {
        const c = await get<{ data: Record<string, string> }>('/api/admin/config');
        let parsed: unknown = [];
        try {
          parsed = JSON.parse(c.data.mediaBuckets || '[]');
        } catch {
          parsed = [];
        }
        buckets = normalize(parsed);
      } catch {
        buckets = [];
      }
    }
    if (!buckets.some((b) => b.id === selectedId)) selectedId = buckets[0]?.id ?? 'r2';
  }

  async function load() {
    error = '';
    try {
      const params = new URLSearchParams();
      params.set('prefix', filter || 'uploads/');
      if (selectedId) params.set('bucket', selectedId);
      const d = await get<{ data: { objects: { key: string; size: number; uploaded: string | null }[] } }>(
        `/api/admin/media/list?${params}`,
      );
      items = (d.data.objects || []).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded ? new Date(o.uploaded).getTime() : 0 }));
    } catch (e) {
      error = msg(e);
      items = [];
    }
  }

  async function upload(source: File) {
    uploading = true;
    error = '';
    progress = `正在压缩：${source.name}`;
    try {
      const prepared = await prepareImage(source);
      const file = prepared.file;
      const note = compressNote(prepared);
      progress = `上传中：${file.name}${note ? `（${note}）` : ''}`;
      const fd = new FormData();
      fd.append('file', file);
      if (selectedId) fd.append('bucket', selectedId);
      const qs = selectedId ? `?bucket=${encodeURIComponent(selectedId)}` : '';
      const res = await fetch(getApiBase() + '/api/admin/media' + qs, { method: 'POST', credentials: 'include', body: fd });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || '上传失败');
      progress = `已上传：${mediaLink(selected, d.data.key)}${note ? `（${note}）` : ''}`;
      setTimeout(() => (progress = ''), 3500);
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      uploading = false;
    }
  }

  function onPick() {
    if (!input?.files) return;
    for (const f of Array.from(input.files)) void upload(f);
    input.value = '';
  }

  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(mediaLink(selected, key));
      progress = '已复制链接';
      setTimeout(() => (progress = ''), 2000);
    } catch {
      error = '复制失败，请手动选取';
    }
  }

  async function remove(key: string) {
    if (!confirm(`删除 ${key}？`)) return;
    try {
      const qs = selectedId ? `?bucket=${encodeURIComponent(selectedId)}` : '';
      await del('/api/admin/media/' + encodeURIComponent(key) + qs);
      await load();
    } catch (e) {
      error = msg(e);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files) for (const f of Array.from(files)) void upload(f);
  }

  /* ---------------- 管理存储桶抽屉 ---------------- */

  function openDrawer() {
    rows = buckets.map((b, i) => {
      const k = `${b.id}#${i}`;
      return {
        __k: k,
        id: b.id,
        label: b.label,
        kind: b.kind,
        binding: b.binding ?? '',
        bucket: b.bucket ?? '',
        endpoint: b.endpoint ?? '',
        region: b.region ?? '',
        baseUrl: b.baseUrl ?? '',
        prefix: b.prefix ?? '',
        publicRead: b.publicRead !== false,
        accessKeyId: '',
        secretAccessKey: '',
      };
    });
    secretByK = {};
    buckets.forEach((b, i) => (secretByK[`${b.id}#${i}`] = { accessKeyId: b.accessKeyId ?? '', secretAccessKey: b.secretAccessKey ?? '' }));
    draftError = '';
    draftNotice = '';
    drawer = true;
  }

  function addRow() {
    rows = [...rows, { __k: `new#${Date.now()}`, id: '', label: '', kind: 'r2', binding: '', bucket: '', endpoint: '', region: '', baseUrl: '', prefix: '', accessKeyId: '', secretAccessKey: '', publicRead: true }];
  }

  function dropRow(k: string) {
    rows = rows.filter((r) => r.__k !== k);
  }

  async function saveBuckets() {
    draftError = '';
    const trimmed = rows.map((r) => ({ ...r, id: r.id.trim(), label: r.label.trim() }));
    if (trimmed.some((r) => !r.id)) {
      draftError = '每个存储桶都要有 id';
      return;
    }
    if (new Set(trimmed.map((r) => r.id)).size !== trimmed.length) {
      draftError = '存储桶 id 不能重复';
      return;
    }
    const out = trimmed.map((r) => {
      const secret = secretByK[r.__k] ?? { accessKeyId: '', secretAccessKey: '' };
      const o: Bucket = { id: r.id, label: r.label || r.id, kind: r.kind };
      if (r.binding.trim()) o.binding = r.binding.trim();
      if (r.bucket.trim()) o.bucket = r.bucket.trim();
      if (r.endpoint.trim()) o.endpoint = r.endpoint.trim();
      if (r.region.trim()) o.region = r.region.trim();
      if (r.baseUrl.trim()) o.baseUrl = r.baseUrl.trim();
      if (r.prefix.trim()) o.prefix = r.prefix.trim();
      // 只在「显式关掉」时落这个键：默认（不写）= 匿名可读，等于现有线上行为，一个图都不会因此变 404
      if (r.publicRead === false) o.publicRead = false;
      const ak = r.accessKeyId.trim() || secret.accessKeyId; // 留空即沿用已存密钥
      const sk = r.secretAccessKey.trim() || secret.secretAccessKey;
      if (ak) o.accessKeyId = ak;
      if (sk) o.secretAccessKey = sk;
      return o;
    });
    draftSaving = true;
    try {
      await patch('/api/admin/config', { mediaBuckets: JSON.stringify(out) });
      buckets = normalize(out);
      if (!buckets.some((b) => b.id === selectedId)) selectedId = buckets[0]?.id ?? '';
      draftNotice = '存储桶配置已保存';
      await load();
      setTimeout(() => {
        draftNotice = '';
        drawer = false;
      }, 900);
    } catch (e) {
      draftError = msg(e);
    } finally {
      draftSaving = false;
    }
  }

  $effect(() => {
    void loadMediaBases();
    void loadBuckets().then(() => void load());
  });

  const fmtSize = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(2) + 'MB' : (n / 1024).toFixed(1) + 'KB');
  const isImg = (k: string) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(k);
  const hasStored = (k: string, field: 'accessKeyId' | 'secretAccessKey') => Boolean(secretByK[k]?.[field]);
</script>

<div class="row spread head">
  <h2>媒体库</h2>
  <div class="row">
    {#if buckets.length}
      <label class="picker">
        存储桶
        <select bind:value={selectedId} onchange={() => void load()}>
          {#each buckets as b (b.id)}
            <option value={b.id}>{b.label}（{b.kind}）</option>
          {/each}
        </select>
      </label>
    {/if}
    <input class="flt" placeholder="按前缀过滤，如 uploads/2026" bind:value={filter} onkeydown={(e) => e.key === 'Enter' && load()} />
    <button class="sm" onclick={openDrawer}>管理存储桶</button>
  </div>
</div>

<p class="muted small">
  {#if selected}
    当前桶：<strong>{selected.label}</strong> · {selected.kind}
    {#if selected.endpoint}· {selected.endpoint}{/if}
    {#if selected.baseUrl}· 公开域名 {selected.baseUrl}{/if}
  {:else}
    还没有配置存储桶，点「管理存储桶」新增。
  {/if}
  {#if !bucketsFromApi}<span class="warn"> · 未读到 /api/admin/media/buckets，暂用配置 mediaBuckets 渲染。</span>{/if}
  {#if selected && linkKind !== 'direct'}
    <span class="warn">
      · 这个桶没有公开域名，「复制链接」给的是 Worker 代理地址（/api/media/…）：访客不登录也打得开，但每张图都要接口转发一次。
      要改成直链，在「管理存储桶」里给这个桶填 baseUrl，或到「设置 → 头像与媒体」填「媒体公开域名」。
      {#if linkKind === 'relative'}接口域名也没读到，这条现在还是站内相对路径 —— 站点与接口不同源时放进正文访客看不到。{/if}
    </span>
  {/if}
</p>

<div
  class="drop card"
  role="button"
  tabindex="0"
  ondrop={onDrop}
  ondragover={(e) => e.preventDefault()}
  onclick={() => input.click()}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  }}
>
  <p>拖拽文件到此处，或点击选择（支持多张，单文件 ≤ 20MB）</p>
  <input bind:this={input} type="file" multiple hidden onchange={onPick} accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon,image/tiff,image/heic,video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/flac,application/pdf" />
  <p class="muted small">
    上传会带上选中的存储桶 id；桶配了公开域名复制出来就是直链，没配则是访客也能打开的 Worker 代理链接，绝不会是需要登录的后台地址。
    位图（JPEG / PNG / AVIF…）会在浏览器里先转成 WebP 再上传，只存 WebP 那一份，像素尺寸不变；GIF 与 SVG 原样上传。
  </p>
</div>

{#if uploading}<p class="muted">{progress}</p>{/if}
{#if error}<p class="err">{error}</p>{/if}

<div class="grid">
  {#each items as it (it.key)}
    <div class="card tile">
      {#if isImg(it.key)}
        <img src={mediaLink(selected, it.key)} alt={it.key} loading="lazy" />
      {:else}
        <div class="file">🗎 {it.key.split('/').pop()}</div>
      {/if}
      <div class="meta">
        <span class="muted">{fmtSize(it.size)}</span>
        <div class="ops">
          <button class="sm" onclick={() => void copy(it.key)}>复制链接</button>
          <button class="sm danger" onclick={() => void remove(it.key)}>删除</button>
        </div>
      </div>
    </div>
  {/each}
</div>

{#if !items.length && !error}<p class="muted">这个桶里还没有媒体文件。</p>{/if}

{#if drawer}
  <div class="scrim" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) drawer = false; }}>
    <div class="panel">
      <div class="row spread">
        <h3>管理存储桶</h3>
        <button class="sm ghost" onclick={() => (drawer = false)}>关闭</button>
      </div>
      <p class="muted small">
        保存写入配置键 <code>mediaBuckets</code>。<strong>r2</strong> 走 Worker 绑定的 <code>binding</code>；<strong>s3</strong> 走
        <code>bucket/endpoint/region/accessKeyId/secretAccessKey</code>。密钥留空表示不覆盖已存值。
      </p>
      {#if draftError}<p class="err">{draftError}</p>{/if}
      {#if draftNotice}<p class="ok">{draftNotice}</p>{/if}

      {#each rows as r, i (r.__k)}
        <div class="brow card">
          <div class="row spread brow-head">
            <span class="muted small">#{i + 1}</span>
            <button class="sm danger" onclick={() => dropRow(r.__k)}>删除此桶</button>
          </div>
          <div class="bfields">
            <label>id *<input bind:value={r.id} placeholder="如 primary" /></label>
            <label>名称<input bind:value={r.label} placeholder="显示名" /></label>
            <label>
              类型
              <select bind:value={r.kind}>
                <option value="r2">r2</option>
                <option value="s3">s3</option>
              </select>
            </label>
            {#if r.kind === 'r2'}
              <label>binding<input bind:value={r.binding} placeholder="R2" /></label>
            {:else}
              <label>bucket<input bind:value={r.bucket} placeholder="桶名" /></label>
              <label>endpoint<input bind:value={r.endpoint} placeholder="https://s3…" /></label>
              <label>region<input bind:value={r.region} placeholder="auto" /></label>
              <label>accessKeyId<input type="password" bind:value={r.accessKeyId} placeholder={hasStored(r.__k, 'accessKeyId') ? '已设置，留空不改' : '选填'} /></label>
              <label>secretAccessKey<input type="password" bind:value={r.secretAccessKey} placeholder={hasStored(r.__k, 'secretAccessKey') ? '已设置，留空不改' : '选填'} /></label>
            {/if}
            <label>baseUrl<input bind:value={r.baseUrl} placeholder="公开访问域名，选填" /></label>
            <label>prefix<input bind:value={r.prefix} placeholder="uploads/，选填" /></label>
            <label>
              <input type="checkbox" bind:checked={r.publicRead} />
              允许匿名读取（走 {`/api/media/${r.id || '<id>'}/…`}）
            </label>
            {#if !r.publicRead}
              <p class="warn">
                关掉之后访客端拿到 403：正文、封面、头像里凡是用 <code>/api/media/{r.id || '这个桶'}/…</code> 的地址全部点不开
                （有 <code>baseUrl</code> 直链的图不受影响）。内部用的桶才这样关；要公开的图请放到有公开域名的桶，或把这格重新勾上。
              </p>
            {:else}
              <p class="muted">
                勾着 = 任何人拿到对象键就能通过这个桶读到文件（键是 <code>uploads/日期/uuid</code>，猜不到，但出现在页面源码里的就等于公开的）。
                只想内部用的桶，取消勾选。
              </p>
            {/if}
          </div>
        </div>
      {/each}

      <div class="row">
        <button class="sm" onclick={addRow}>+ 添加存储桶</button>
        <span class="grow"></span>
        <button class="primary" onclick={() => void saveBuckets()} disabled={draftSaving}>{draftSaving ? '保存中…' : '保存全部'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .head {
    margin-bottom: 0.7rem;
  }
  .flt {
    min-width: 200px;
  }
  .picker {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .picker select {
    min-width: 150px;
  }
  .drop {
    border: 1.5px dashed var(--border);
    text-align: center;
    padding: 1.4rem;
    margin-bottom: 1rem;
    cursor: pointer;
  }
  .drop:hover {
    border-color: var(--accent);
  }
  .drop p {
    margin: 0.2rem 0;
  }
  .small {
    font-size: 0.78rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.7rem;
  }
  .tile {
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .tile img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 6px;
    background: #f2f2f2;
  }
  .file {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    border-radius: 6px;
    font-size: 0.78rem;
    padding: 0.4rem;
    word-break: break-all;
    text-align: center;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.78rem;
  }
  .ops {
    display: flex;
    gap: 0.3rem;
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    justify-content: flex-end;
    z-index: 50;
  }
  .panel {
    width: min(560px, 94vw);
    height: 100%;
    overflow-y: auto;
    background: var(--bg);
    border-left: 1px solid var(--border);
    padding: 1rem 1.1rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .brow {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .brow-head {
    align-items: center;
  }
  .bfields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.55rem;
  }
  .row .grow {
    flex: 1;
  }
</style>
