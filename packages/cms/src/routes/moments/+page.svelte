<script lang="ts">
  import { get, put, del, purgeNote, type PurgeOut } from '#lib/api';
  import MarkdownEditor from '#lib/MarkdownEditor.svelte';
  import { renderMarkdown, splitFrontMatter } from '#lib/markdown';
  import { frontUrl } from '#lib/session.svelte';
  import MediaPicker from '../content/MediaPicker.svelte';
  import { composeFile, fromDateInput, nowInput, parseFront, toInputDateTime, yq, type FrontDoc } from '../content/_frontmatter';

  /**
   * 时刻已经是「仓库 md」形态：D1 的 moments 表在 round2 迁移里被删掉，
   * 所以列表读仓库目录，发布 / 删除都走后台的内容文件接口，不再调 /api/moments 的增删。
   *
   * 媒体上限按主题 zero-theme/layouts/moments 实际读取的字段来：
   *   images（数组，最多 9 张，九宫格预览）+ video（单值）+ music（单值，即音频）
   * 正文里的站内短链 [[...]] 只是文本，不计入这些数量限制。
   */

  interface Entry {
    name: string;
    path: string;
    type: 'file' | 'dir';
  }

  interface Moment {
    path: string;
    name: string;
    date: string;
    draft: boolean;
    body: string;
    images: string[];
    video: string;
    videoPoster: string;
    music: string;
    musicTitle: string;
    location: string;
    tags: string[];
    link: { url: string; title: string; desc: string; image: string };
    doc: FrontDoc;
  }

  const MAX_IMAGES = 9;

  let momentsDir = $state('content/zh/moments');
  let list = $state<Moment[]>([]);
  let loading = $state(false);
  let error = $state('');
  let notice = $state('');

  // 发布表单
  let editing = $state('');
  let body = $state('');
  let location = $state('');
  let date = $state(nowInput());
  let tags = $state<string[]>([]);
  let tagInput = $state('');
  let draft = $state(false);
  let baseDoc = $state<FrontDoc>(parseFront(''));
  let saving = $state(false);

  // 媒体：九宫格图片 + 单个音频 + 单个视频
  let images = $state<string[]>([]);
  let video = $state('');
  let videoPoster = $state('');
  let audio = $state('');
  let audioTitle = $state('');
  let imageUrl = $state('');

  // 链接卡（朋友圈那种「文字 + 一条链接」），四个字段都可只填 url
  let linkUrl = $state('');
  let linkTitle = $state('');
  let linkDesc = $state('');
  let linkImage = $state('');

  // 媒体选择面板：记住这次是给哪一类挑文件
  let showMedia = $state(false);
  let pickTarget = $state<'image' | 'video' | 'audio' | 'link'>('image');

  async function load() {
    loading = true;
    error = '';
    try {
      const cfg = await get<{ data: Record<string, string> }>('/api/admin/config');
      const dir = (cfg.data?.githubMomentsDir || 'content/zh/moments').replace(/^\/+|\/+$/g, '');
      momentsDir = dir;
      const d = await get<{ data: Entry[] }>(`/api/admin/content?path=${encodeURIComponent(dir)}`);
      const files = (d.data || []).filter((e) => e.type === 'file' && e.name.endsWith('.md') && e.name !== '_index.md');
      const recent = files.slice(-30).reverse();
      const docs = await Promise.all(
        recent.map(async (f) => {
          try {
            const r = await get<{ data: { content: string } }>(`/api/admin/content/file?path=${encodeURIComponent(f.path)}`);
            return toMoment(f, r.data.content);
          } catch {
            return null;
          }
        }),
      );
      list = docs
        .filter((m): m is Moment => Boolean(m))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    } catch (e) {
      error = e instanceof Error ? e.message : '读取时刻目录失败，请确认已在设置页配置 Git 仓库与 GITHUB_TOKEN';
      list = [];
    } finally {
      loading = false;
    }
  }

  function toMoment(f: Entry, raw: string): Moment {
    const parts = splitFrontMatter(raw);
    const doc = parseFront(parts.front);
    const s = doc.scalars;
    return {
      path: f.path,
      name: f.name,
      date: s.date ?? '',
      draft: (s.draft ?? 'false') === 'true',
      body: parts.body,
      images: [...(doc.lists.images ?? [])],
      video: s.video ?? '',
      videoPoster: s.video_poster ?? '',
      music: s.music ?? '',
      musicTitle: s.music_title ?? '',
      location: s.location ?? '',
      tags: [...(doc.lists.tags ?? [])],
      link: {
        url: s['link.url'] ?? '',
        title: s['link.title'] ?? '',
        desc: s['link.desc'] ?? '',
        image: s['link.image'] ?? '',
      },
      doc,
    };
  }

  /** 表单 → 时刻 front matter（未识别的原有键由 extras 原样带回） */
  function momentFront(): string {
    const lines: string[] = [];
    lines.push(`date: ${fromDateInput(date) || date}`);
    lines.push(`draft: ${draft ? 'true' : 'false'}`);
    if (images.length) {
      lines.push('images:');
      for (const u of images) lines.push(`  - ${yq(u)}`);
    }
    if (video) {
      lines.push(`video: ${yq(video)}`);
      if (videoPoster) lines.push(`video_poster: ${yq(videoPoster)}`);
    }
    if (audio) {
      lines.push(`music: ${yq(audio)}`);
      if (audioTitle) lines.push(`music_title: ${yq(audioTitle)}`);
    }
    if (location.trim()) lines.push(`location: ${yq(location.trim())}`);
    if (linkUrl.trim()) {
      lines.push('link:');
      lines.push(`  url: ${yq(linkUrl.trim())}`);
      if (linkTitle.trim()) lines.push(`  title: ${yq(linkTitle.trim())}`);
      if (linkDesc.trim()) lines.push(`  desc: ${yq(linkDesc.trim())}`);
      if (linkImage.trim()) lines.push(`  image: ${yq(linkImage.trim())}`);
    }
    if (tags.length) {
      lines.push('tags:');
      for (const t of tags) lines.push(`  - ${yq(t)}`);
    }
    return lines.join('\n');
  }

  /**
   * 本页会重写的键；其余键（link / 自定义字段…）原样带回，避免编辑一条时刻把没展示的字段弄丢。
   */
  const MANAGED = new Set(['date', 'draft', 'images', 'image', 'video', 'video_poster', 'music', 'music_title', 'music_cover', 'tags', 'location', 'link']);

  function extrasFromDoc(doc: FrontDoc): string {
    const lines: string[] = [];
    for (const e of doc.extras) {
      if (MANAGED.has(e.key)) continue;
      if (e.items) {
        lines.push(`${e.key}:`);
        for (const it of e.items) lines.push(`  - ${yq(it)}`);
      } else if (e.block) {
        lines.push(`${e.key}:`);
        for (const b of e.block) lines.push(b);
      } else {
        lines.push(`${e.key}: ${e.value}`);
      }
    }
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- 媒体添加 */

  function openMedia(target: 'image' | 'video' | 'audio' | 'link') {
    if (target === 'image' && images.length >= MAX_IMAGES) {
      error = `图片最多 ${MAX_IMAGES} 张，已达上限，请先移除一张再添加`;
      return;
    }
    error = '';
    pickTarget = target;
    showMedia = true;
  }

  /** 媒体库/上传选中的地址按当前目标归类，并守住 9 图 / 单音 / 单视频 的上限 */
  function onMediaPick(url: string) {
    const u = url.trim();
    if (!u) return;
    if (pickTarget === 'image') {
      if (images.length >= MAX_IMAGES) {
        error = `图片最多 ${MAX_IMAGES} 张，已达上限`;
        return;
      }
      if (!images.includes(u)) images = [...images, u];
    } else if (pickTarget === 'video') {
      video = u;
    } else if (pickTarget === 'link') {
      linkImage = u;
    } else {
      audio = u;
    }
  }

  function addImageUrl() {
    const u = imageUrl.trim();
    if (!/^https?:\/\//i.test(u)) {
      error = '图片地址需以 http(s):// 开头，可从媒体库选择或上传';
      return;
    }
    if (images.length >= MAX_IMAGES) {
      error = `图片最多 ${MAX_IMAGES} 张，已达上限，请先移除一张再添加`;
      return;
    }
    error = '';
    if (!images.includes(u)) images = [...images, u];
    imageUrl = '';
  }

  function removeImage(i: number) {
    images = images.filter((_, x) => x !== i);
  }

  function addTag(raw: string) {
    const v = raw.trim();
    if (!v || tags.includes(v)) {
      tagInput = '';
      return;
    }
    tags = [...tags, v];
    tagInput = '';
  }

  /** 朋友圈式发布：没有标题，五类内容任有一项就算可发布 */
  function hasContent() {
    return Boolean(
      body.trim() || images.length || video || audio || linkUrl.trim(),
    );
  }

  async function save() {
    if (!hasContent()) {
      error = '正文、图片、视频、音乐、链接至少填一项';
      return;
    }
    if (!date) {
      error = '日期必填';
      return;
    }
    saving = true;
    error = '';
    const front = [momentFront(), extrasFromDoc(baseDoc)].filter(Boolean).join('\n');
    const path = editing || `${momentsDir}/${newSlug()}.md`;
    try {
      await put<{ data: { sha?: string } }>('/api/admin/content/file', {
        path,
        front: {
          date: fromDateInput(date) || date,
          draft,
          images,
          video: video || null,
          video_poster: videoPoster || null,
          music: audio || null,
          music_title: audioTitle || null,
          location: location.trim() || null,
          tags,
          link: linkUrl.trim()
            ? { url: linkUrl.trim(), title: linkTitle.trim(), desc: linkDesc.trim(), image: linkImage.trim() }
            : null,
        },
        body,
        message: `zero-cms: ${editing ? 'update' : 'publish'} ${path}`,
        // 兼容只认 content 的后端
        content: composeFile(front, body),
      });
      notice = editing ? '时刻已更新到仓库 ✓' : '时刻已发布到仓库 ✓';
      resetForm();
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '发布失败';
    } finally {
      saving = false;
      setTimeout(() => (notice = ''), 3000);
    }
  }

  function newSlug(): string {
    const rnd =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(16).slice(2, 14);
    return rnd;
  }

  function resetForm() {
    editing = '';
    body = '';
    location = '';
    date = nowInput();
    tags = [];
    tagInput = '';
    draft = false;
    images = [];
    video = '';
    videoPoster = '';
    audio = '';
    audioTitle = '';
    imageUrl = '';
    linkUrl = '';
    linkTitle = '';
    linkDesc = '';
    linkImage = '';
    baseDoc = parseFront('');
  }

  function edit(m: Moment) {
    editing = m.path;
    body = m.body;
    location = m.location;
    date = toInputDateTime(m.date) || nowInput();
    tags = [...m.tags];
    draft = m.draft;
    baseDoc = m.doc;
    images = [...m.images].slice(0, MAX_IMAGES);
    video = m.video;
    videoPoster = m.videoPoster;
    audio = m.music;
    audioTitle = m.musicTitle;
    linkUrl = m.link.url;
    linkTitle = m.link.title;
    linkDesc = m.link.desc;
    linkImage = m.link.image;
    notice = `正在编辑 ${m.name}`;
  }

  async function remove(m: Moment) {
    if (!confirm(`删除 ${m.name}？仓库里的这条时刻文件会被提交删除。`)) return;
    error = '';
    try {
      const res = await del<{ data: { purge: PurgeOut | null } }>(
        `/api/admin/content/file?path=${encodeURIComponent(m.path)}`,
      );
      if (editing === m.path) resetForm();
      await load();
      notice = `已删除${purgeNote(res?.data?.purge)}`;
      setTimeout(() => (notice = ''), 8000);
    } catch (e) {
      error = e instanceof Error ? e.message : '删除失败';
    }
  }

  $effect(() => void load());
</script>

<div class="row spread head">
  <h2>时刻</h2>
  <div class="row">
    <code class="dir">{momentsDir}</code>
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
  </div>
</div>

<p class="muted small">
  发布即写仓库 <code>{momentsDir}/&lt;slug&gt;.md</code>，目录取自设置页 githubMomentsDir；卡片按 front matter 的
  images / video / music 渲染。正文里的站内短链 <code>[[…]]</code> 只算文本，不计入媒体数量。
</p>
{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

<section class="card form">
  <div class="row spread">
    <h3>{editing ? '编辑时刻' : '发一条时刻'}</h3>
    {#if editing}<button class="sm ghost" onclick={resetForm}>改为新建</button>{/if}
  </div>

  <MarkdownEditor bind:value={body} rows={5} placeholder="此刻的想法、照片或链接…" />

  <div class="grid2">
    <label>日期<input type="datetime-local" bind:value={date} /></label>
    <label>地点（可选）<input placeholder="城市 / 地点" bind:value={location} /></label>
  </div>

  <!-- 图片九宫格：最多 9 张 -->
  <div class="block">
    <div class="row spread lbl">
      <span>图片（{images.length}/{MAX_IMAGES}，九宫格）</span>
      <button class="sm" onclick={() => openMedia('image')} disabled={images.length >= MAX_IMAGES}>
        {images.length >= MAX_IMAGES ? '已达 9 张上限' : '＋ 从媒体库/上传'}
      </button>
    </div>
    <div class="nine">
      {#each images as u, i (u + i)}
        <div class="cell9">
          <img src={u} alt="" loading="lazy" title={u} />
          <button class="rm" title="移除这张" onclick={() => removeImage(i)}>✕</button>
        </div>
      {/each}
      {#if images.length < MAX_IMAGES}
        <button class="add9" title="添加图片" onclick={() => openMedia('image')}>＋</button>
      {/if}
    </div>
    <div class="row">
      <input class="grow" placeholder="也可直接粘贴图片地址 https://…" bind:value={imageUrl} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addImageUrl())} />
      <button class="sm" onclick={addImageUrl} disabled={images.length >= MAX_IMAGES}>添加图片</button>
    </div>
    {#if images.length >= MAX_IMAGES}<p class="muted small">图片已满 {MAX_IMAGES} 张，需要先移除一张才能再加。</p>{/if}
  </div>

  <!-- 视频：最多 1 个 -->
  <div class="block">
    <span class="lbl">视频（最多 1 个）</span>
    {#if video}
      <div class="one">
        <span class="badge">▶ 视频</span> <span class="url" title={video}>{video}</span>
        <button class="sm ghost" onclick={() => openMedia('video')}>替换</button>
        <button class="sm ghost" onclick={() => (video = '')}>移除</button>
      </div>
      <label class="sub">封面（video_poster，可选）<input placeholder="https://…/cover.jpg" bind:value={videoPoster} /></label>
    {:else}
      <div class="row">
        <button class="sm" onclick={() => openMedia('video')}>＋ 选择/上传视频</button>
        <span class="muted small">已有视频会显示“替换/移除”，不允许再加第二个。</span>
      </div>
    {/if}
  </div>

  <!-- 音频：最多 1 个（主题读 front music 字段） -->
  <div class="block">
    <span class="lbl">音频（最多 1 个）</span>
    {#if audio}
      <div class="one">
        <span class="badge">♪ 音频</span> <span class="url" title={audio}>{audio}</span>
        <button class="sm ghost" onclick={() => openMedia('audio')}>替换</button>
        <button class="sm ghost" onclick={() => (audio = '')}>移除</button>
      </div>
      <label class="sub">标题（music_title，可选）<input placeholder="歌曲 / 节目标题" bind:value={audioTitle} /></label>
    {:else}
      <div class="row">
        <button class="sm" onclick={() => openMedia('audio')}>＋ 选择/上传音频</button>
        <span class="muted small">已有音频会显示“替换/移除”，不允许再加第二个。</span>
      </div>
    {/if}
  </div>

  <!-- 链接：朋友圈式的一条分享，只填网址也能发 -->
  <div class="block">
    <span class="lbl">链接（可选）</span>
    <input class="grow" placeholder="https://… 分享的文章或页面地址" bind:value={linkUrl} />
    {#if linkUrl.trim()}
      <div class="grid2">
        <label class="sub">标题<input placeholder="链接标题，留空用域名" bind:value={linkTitle} /></label>
        <label class="sub">说明<input placeholder="一句话介绍" bind:value={linkDesc} /></label>
      </div>
      <div class="one">
        <span class="badge">◇ 封面</span>
        {#if linkImage}
          <span class="url" title={linkImage}>{linkImage}</span>
          <button class="sm ghost" onclick={() => openMedia('link')}>替换</button>
          <button class="sm ghost" onclick={() => (linkImage = '')}>移除</button>
        {:else}
          <button class="sm" onclick={() => openMedia('link')}>＋ 选一张封面</button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="block">
    <span class="lbl">标签（多个）</span>
    <div class="chips">
      {#each tags as t, i (t)}
        <button class="chip on" onclick={() => (tags = tags.filter((_, x) => x !== i))}>{t} ✕</button>
      {/each}
    </div>
    <div class="row">
      <input placeholder="回车添加标签" bind:value={tagInput} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag(tagInput))} />
      <button class="sm" onclick={() => addTag(tagInput)}>添加</button>
    </div>
  </div>

  <div class="row">
    <label class="switch">
      <input type="checkbox" bind:checked={draft} />
      <span>草稿（draft，前台不展示）</span>
    </label>
    <button class="primary" onclick={() => void save()} disabled={saving}>{saving ? '提交中…' : editing ? '保存修改' : '发布'}</button>
  </div>
</section>

<h3>时间轴 <span class="muted small">（仓库目录内最近 {list.length} 条）</span></h3>
{#each list as m (m.path)}
  <article class="card item">
    <div class="row spread top">
      <div class="row tags">
        {#if m.draft}<span class="badge pending">草稿</span>{/if}
        {#if m.location}<span class="badge">📍 {m.location}</span>{/if}
        {#each m.tags as t (t)}<span class="badge">{t}</span>{/each}
      </div>
      <div class="row">
        <span class="muted small">{m.date || '无日期'}</span>
        <button class="sm" onclick={() => edit(m)}>编辑</button>
        <button class="sm danger" onclick={() => void remove(m)}>删除</button>
      </div>
    </div>
    <!-- 预览里的 [[文章]] 链接要指向前台：站点地址没配就退回相对路径，配了就用完整地址 -->
    <div class="text">{@html renderMarkdown(m.body, { shortBase: frontUrl('/posts/') || '/posts/' })}</div>
    {#if m.images.length || m.video || m.music || m.link.url}
      <div class="thumbs">
        {#each m.images as u (u)}<img src={u} alt="" loading="lazy" />{/each}
        {#if m.video}<span class="badge">▶ 视频</span>{/if}
        {#if m.music}<span class="badge">♪ 音频</span>{/if}
        {#if m.link.url}<span class="badge" title={m.link.url}>◇ {m.link.title || m.link.url}</span>{/if}
      </div>
    {/if}
    <code class="muted small file" title={m.path}>{m.path}</code>
  </article>
{/each}
{#if !list.length && !loading}<p class="muted">仓库里还没有时刻文件。</p>{/if}

<MediaPicker bind:open={showMedia} title={pickTarget === 'image' ? '选择图片' : pickTarget === 'video' ? '选择视频' : pickTarget === 'link' ? '选择链接封面' : '选择音频'} kind="any" onpick={onMediaPick} />

<style>
  .head {
    margin-bottom: 0.7rem;
  }
  .dir,
  .file {
    font-size: 0.76rem;
    color: var(--muted);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    margin-bottom: 1.2rem;
  }
  .form h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.6rem;
  }
  .small {
    font-size: 0.76rem;
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .lbl {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .sub {
    font-size: 0.78rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.86rem;
    color: var(--fg);
  }
  .switch input {
    width: 16px;
    height: 16px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    min-height: 22px;
  }
  .chip {
    padding: 0.1rem 0.55rem;
    font-size: 0.76rem;
    border-radius: 999px;
  }
  .chip.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  /* 九宫格：列数按可用宽度排，320px 的屏上不会顶破卡片 */
  .nine {
    display: grid;
    grid-template-columns: repeat(auto-fill, 96px);
    gap: 0.4rem;
  }
  .cell9,
  .add9 {
    position: relative;
    width: 96px;
    height: 96px;
    border-radius: 8px;
    overflow: hidden;
    padding: 0;
  }
  .cell9 img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .cell9 .rm {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 20px;
    height: 20px;
    line-height: 1;
    padding: 0;
    border-radius: 50%;
    border: none;
    background: rgba(17, 24, 39, 0.6);
    color: #fff;
    font-size: 0.8rem;
  }
  .add9 {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--border);
    background: #f9fafb;
    color: var(--muted);
    font-size: 1.5rem;
    cursor: pointer;
  }
  .add9:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .grow {
    flex: 1;
    min-width: 200px;
  }
  .one {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .url {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .item {
    margin-bottom: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .top {
    align-items: center;
  }
  .tags {
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .text :global(p) {
    margin: 0.3rem 0;
    line-height: 1.75;
  }
  .text :global(pre) {
    background: #f3f4f6;
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    overflow: auto;
    font-size: 0.82rem;
  }
  .text :global(code) {
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0.04rem 0.3rem;
    font-size: 0.86em;
  }
  .text :global(blockquote) {
    margin: 0.5rem 0;
    padding: 0.1rem 0.8rem;
    border-left: 3px solid var(--accent);
    background: var(--accent-soft);
  }
  .text :global(img) {
    max-width: 100%;
  }
  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }
  .thumbs img {
    width: 92px;
    height: 92px;
    object-fit: cover;
    border-radius: 6px;
  }
</style>
