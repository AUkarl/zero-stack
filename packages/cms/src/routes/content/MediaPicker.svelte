<script lang="ts">
  import { get, getApiBase } from '#lib/api';
  import { compressNote, prepareImage } from '#lib/image-compress';
  import { uploadVariants } from '#lib/media-variants';
  import { loadMediaBases, mediaLink, mediaLinkKind } from '#lib/media-url.svelte';

  interface MediaObj {
    key: string;
    name?: string;
    size?: number;
    uploaded?: string | null;
  }
  interface Bucket {
    id: string;
    label?: string;
    kind?: string;
    baseUrl?: string;
    prefix?: string;
  }

  let {
    open = $bindable(false),
    title = '从媒体库选择',
    kind = 'image',
    onpick,
  }: {
    open?: boolean;
    title?: string;
    /** image 只显示图片扩展名，any 显示全部 */
    kind?: 'image' | 'any';
    onpick: (url: string) => void;
  } = $props();

  const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|svg)$/i;
  const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

  let buckets = $state<Bucket[]>([]);
  let selBucket = $state('');
  let items = $state<MediaObj[]>([]);
  let loading = $state(false);
  let error = $state('');
  let prefix = $state('uploads/');
  let q = $state('');

  let truncated = $state(false);
  let nextCursor = $state<string | null>(null);
  let loadingMore = $state(false);

  let uploading = $state(false);
  let uploadPct = $state(0);
  let uploadMsg = $state('');
  let fileEl = $state<HTMLInputElement | null>(null);

  const selInfo = $derived(buckets.find((b) => b.id === selBucket) ?? null);
  const linkKind = $derived(mediaLinkKind(selInfo));

  function urlOf(o: MediaObj): string {
    return mediaLink(selInfo, o.key);
  }

  async function loadBuckets() {
    error = '';
    try {
      const d = await get<{ data: Bucket[] }>('/api/admin/media/buckets');
      buckets = d.data || [];
      if (!selBucket || !buckets.some((b) => b.id === selBucket)) selBucket = buckets[0]?.id ?? '';
    } catch (e) {
      buckets = [];
      error = e instanceof Error ? e.message : '读取存储桶失败';
    }
  }

  async function loadObjects(reset = true) {
    if (reset) {
      loading = true;
      error = '';
      items = [];
      nextCursor = null;
    } else {
      if (!nextCursor) return;
      loadingMore = true;
    }
    try {
      const params = new URLSearchParams();
      if (selBucket) params.set('bucket', selBucket);
      params.set('prefix', prefix || 'uploads/');
      params.set('limit', '200');
      if (!reset && nextCursor) params.set('cursor', nextCursor);
      const d = await get<{
        data: { objects: MediaObj[]; truncated?: boolean; cursor?: string | null };
      }>(`/api/admin/media/list?${params}`);
      const objs = d.data.objects || [];
      items = reset ? objs : [...items, ...objs];
      truncated = Boolean(d.data.truncated);
      nextCursor = d.data.cursor ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : '读取媒体列表失败，确认后台已配置存储桶并在登录页填好 API 地址';
      if (reset) items = [];
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  function switchBucket() {
    void loadObjects(true);
  }

  const shown = $derived(
    items.filter((o) => {
      if (q.trim() && !o.key.toLowerCase().includes(q.trim().toLowerCase())) return false;
      if (kind === 'image') return IMG_EXT.test(o.key);
      return true;
    }),
  );

  function choose(url: string) {
    if (!url.trim()) return;
    onpick(url.trim());
    open = false;
  }

  function pickLocal() {
    if (fileEl) fileEl.value = '';
    fileEl?.click();
  }

  function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void uploadFile(file);
  }

  /**
   * 本地上传：先按需要在浏览器里转成 WebP（见 #lib/image-compress），再走 FormData
   * （bucket 字段指定桶），用 XHR 拿上传进度反馈中文百分比。
   */
  async function uploadFile(source: File) {
    uploading = true;
    uploadPct = 0;
    error = '';
    uploadMsg = source.type.startsWith('image/') && source.type !== 'image/gif' && source.type !== 'image/svg+xml' ? `正在压缩 ${source.name}…` : `正在上传 ${source.name}…`;
    const prepared = await prepareImage(source);
    const file = prepared.file;
    uploadMsg = `正在上传 ${file.name}…`;
    const fd = new FormData();
    fd.append('file', file);
    if (selBucket) fd.append('bucket', selBucket);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getApiBase()}/api/admin/media`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) uploadPct = Math.round((ev.loaded / ev.total) * 100);
    };
    xhr.onload = () => {
      uploading = false;
      /* 后端固定回 { data: { key, url, bucket, size } }。这里以前直接摸 data.url / data.key，
         那两层字段根本不存在，于是上传明明成功（HTTP 200）也报「上传失败」，
         而且不刷新列表 —— 关掉重开才看得见，正是用户描述的现象。 */
      let stored: { key?: string } | null = null;
      let message = '';
      try {
        const body = JSON.parse(xhr.responseText) as { data?: { key?: string }; message?: string };
        stored = body?.data ?? null;
        message = typeof body?.message === 'string' ? body.message : '';
      } catch {
        stored = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && stored?.key) {
        const note = compressNote(prepared);
        uploadMsg = note ? `上传成功（${file.name}，${note}）` : `上传成功（${file.name}）`;
        choose(mediaLink(selInfo, stored.key));
        /* R44：后台生成三档变体并写清单（不阻塞选中这张图；失败了主题会回退原图） */
        void uploadVariants(file, stored.key, selBucket || undefined);
        void loadObjects(true);
      } else {
        uploadMsg = '';
        error = `上传失败：${message || `后端返回 HTTP ${xhr.status}`}`;
      }
      if (fileEl) fileEl.value = '';
    };
    xhr.onerror = () => {
      uploading = false;
      uploadMsg = '';
      error = '上传失败：网络中断或跨域被拒绝，请确认 API 地址与登录状态';
      if (fileEl) fileEl.value = '';
    };
    xhr.onabort = () => {
      uploading = false;
      uploadMsg = '';
    };
    xhr.send(fd);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }

  $effect(() => {
    if (!open) return;
    void loadMediaBases();
    void (async () => {
      await loadBuckets();
      await loadObjects(true);
    })();
  });
</script>

{#if open}
  <div class="mask" role="presentation" onclick={() => (open = false)} onkeydown={onKeydown}>
    <div
      class="box card"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKeydown}
    >
      <div class="row spread head">
        <h3>{title}</h3>
        <button class="sm ghost" onclick={() => (open = false)}>关闭 ✕</button>
      </div>

      <div class="row filters">
        <label class="bk">
          存储桶
          <select bind:value={selBucket} onchange={switchBucket} aria-label="选择存储桶">
            {#if !buckets.length}<option value="">（无可用桶）</option>{/if}
            {#each buckets as b (b.id)}<option value={b.id}>{b.label || b.id}</option>{/each}
          </select>
        </label>
        <input class="pfx" placeholder="前缀目录，如 uploads/" bind:value={prefix} />
        <input placeholder="按文件名筛选" bind:value={q} />
        <button class="sm" onclick={() => void loadObjects(true)} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
        <button class="sm" onclick={pickLocal} disabled={uploading}>{uploading ? `上传中 ${uploadPct}%` : '上传本地文件'}</button>
        <input type="file" class="fileinput" aria-label="选择要上传的本地文件" bind:this={fileEl} onchange={onFile} accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/x-icon,image/tiff,image/heic,video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,audio/flac,application/pdf" />
      </div>

      {#if uploading}<p class="upbar"><span style="width:{uploadPct}%"></span></p><p class="muted small">{uploadMsg}（{uploadPct}%）</p>{/if}
      {#if !uploading && uploadMsg}<p class="ok small">{uploadMsg}</p>{/if}
      {#if error}<p class="err">{error}</p>{/if}

      <div class="grid">
        {#each shown as o (o.key)}
          <button class="cell" title={o.key} onclick={() => choose(urlOf(o))}>
            {#if IMG_EXT.test(o.key)}
              <img src={urlOf(o)} alt="" loading="lazy" />
            {:else if AUDIO_EXT.test(o.key)}
              <span class="ico">♪</span>
            {:else if VIDEO_EXT.test(o.key)}
              <span class="ico">▶</span>
            {:else}
              <span class="ico">🗎</span>
            {/if}
            <span class="nm">{o.name || o.key.split('/').pop()}</span>
          </button>
        {:else}
          <p class="muted small">{loading ? '读取中…' : '这个前缀下没有可显示的媒体，可换前缀 / 桶，或上传本地文件'}</p>
        {/each}
      </div>

      {#if truncated}
        <div class="row more">
          <button class="sm" onclick={() => void loadObjects(false)} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      {/if}

      <p class="muted small tip">
        {#if kind === 'image'}只显示图片扩展名；{/if}点某条即把地址填回表单；本地文件上传后自动选中并刷新列表。
        {#if linkKind === 'direct'}
          当前桶有公开域名，填进正文的是直链，不占接口请求。
        {:else}
          <span class="warn">
            当前桶没有公开域名，填进正文的是 Worker 代理地址 —— 访客不用登录也打得开，但每张图都要接口转发一次；
            想改成直链，到「媒体库 → 管理存储桶」给这个桶填 baseUrl。
            {#if linkKind === 'relative'}而且接口域名也没读到，这条还是站内相对路径，只有站点与接口同源时访客才打得开。{/if}
          </span>
        {/if}
      </p>
    </div>
  </div>
{/if}

<style>
  .mask {
    position: fixed;
    inset: 0;
    background: rgba(17, 24, 39, 0.42);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.2rem;
    z-index: 50;
  }
  .box {
    width: min(860px, 100%);
    max-height: 88vh;
    overflow: auto;
  }
  .head {
    margin-bottom: 0.5rem;
  }
  .head h3 {
    margin: 0;
  }
  .filters {
    margin-bottom: 0.6rem;
    gap: 0.5rem;
  }
  .bk {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
  }
  .bk select {
    padding: 0.18rem 0.4rem;
    font-size: 0.82rem;
  }
  .pfx {
    width: 150px;
  }
  .fileinput {
    display: none;
  }
  .upbar {
    height: 6px;
    border-radius: 999px;
    background: #eef2e6;
    overflow: hidden;
    margin: 0.1rem 0 0.2rem;
  }
  .upbar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.15s ease;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 0.5rem;
    max-height: 46vh;
    overflow: auto;
    padding: 0.2rem;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.35rem;
    height: 118px;
    overflow: hidden;
  }
  .cell img {
    width: 100%;
    height: 82px;
    object-fit: cover;
    border-radius: 6px;
    background: #f3f4f6;
  }
  .cell .ico {
    width: 100%;
    height: 82px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    border-radius: 6px;
    background: #f3f4f6;
  }
  .nm {
    font-size: 0.7rem;
    color: var(--muted);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    margin-top: 0.6rem;
    justify-content: center;
  }
  .tip {
    margin: 0.5rem 0 0;
  }
  .small {
    font-size: 0.76rem;
  }
</style>
