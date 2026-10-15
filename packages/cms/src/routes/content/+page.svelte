<script lang="ts">
  import { get, post, del } from '#lib/api';
  import MarkdownEditor from '#lib/MarkdownEditor.svelte';
  import { splitFrontMatter } from '#lib/markdown';
  import MediaPicker from './MediaPicker.svelte';
  import ShortcodeBar from './ShortcodeBar.svelte';
  import type { Shortcode } from './_shortcodes';
  import {
    canonSlug,
    composeFile,
    emptyForm,
    fromDateInput,
    formFromDoc,
    frontFromForm,
    nowInput,
    parseFront,
    type FrontDoc,
    type PostForm,
  } from './_frontmatter';
  import { draftOf, formatSavedAt, loadDrafts, removeDraft, saveDrafts, upsertDraft, type Draft } from './_drafts';

  interface Entry {
    name: string;
    path: string;
    type: 'file' | 'dir';
    size?: number;
  }

  let contentDir = $state('content');
  let dir = $state('content');
  let entries = $state<Entry[]>([]);
  let langDirs = $state<string[]>([]);

  let file = $state('');
  let doc = $state<FrontDoc>(parseFront(''));
  let form = $state<PostForm>(emptyForm());
  let baseForm = $state<PostForm>(emptyForm());
  let body = $state('');
  let baseBody = $state('');
  let sha = $state('');

  const dirty = $derived(JSON.stringify(form) !== JSON.stringify(baseForm) || body !== baseBody);

  /* ---------------- 本地暂存队列：「保存本地」→ 右上角「保存到 Git」 ---------------- */

  let drafts = $state<Draft[]>([]);
  let showDrafts = $state(false);
  let pushing = $state(false);
  let hydrated = false;
  /** 推送结果里没成功的部分（冲突 / 失败），列在暂存面板里，改完可以再推 */
  let pushProblems = $state<{ path: string; error: string }[]>([]);

  // 挂载后才读 localStorage（SSR 阶段没有 window）；之后队列有变动就同步写回
  $effect(() => {
    drafts = loadDrafts();
    hydrated = true;
  });
  $effect(() => {
    if (hydrated) saveDrafts(drafts);
  });

  const queued = $derived(drafts.length);
  /** 有队列就推队列；没队列就只推正在编辑的这一篇（含未「保存本地」的当前改动） */
  const pushTargets = $derived.by(() => {
    const list = drafts.slice();
    if (file && dirty) {
      const mine = localDraft();
      if (mine) {
        const i = list.findIndex((x) => x.path === mine.path);
        if (i >= 0) list[i] = mine;
        else list.push(mine);
      }
    }
    return list;
  });

  /** 当前编辑器内容 → 一条暂存记录；标题没填就没有内容可存（返回 null，调用方给提示） */
  function localDraft(): Draft | null {
    if (!file || !form.title.trim()) return null;
    let front: string;
    try {
      front = frontFromForm(form, doc);
    } catch (e) {
      error = e instanceof Error ? e.message : 'front matter 拼装失败';
      return null;
    }
    return {
      path: file,
      title: form.title.trim(),
      front: frontPayload(form),
      body,
      content: composeFile(front, body),
      sha,
      notifySubscribers,
      savedAt: Date.now(),
    };
  }

  /** 保存本地：只写浏览器队列，不发任何请求 */
  function saveLocal() {
    if (!file) {
      error = '还没有可暂存的文件：左列点开一篇，或先「新建文章」；若刚才读取报错，见下方错误信息';
      return;
    }
    const d = localDraft();
    if (!d) {
      error = '标题必填（暂存也要有标题，不然不知道存成哪篇）';
      return;
    }
    error = '';
    drafts = upsertDraft(drafts, d);
    // 本地快照成为新的基准：「未保存」指的是没落盘，落进队列就不算丢改动
    baseForm = { ...form };
    baseBody = body;
    doc = parseFront(frontFromForm(form, doc));
    notice = '已保存到浏览器暂存，点右上角「保存到 Git」才会进仓库';
    setTimeout(() => (notice = ''), 4000);
  }

  /** 右上角「保存到 Git」：整批一次提交，冲突的那篇跳过、留在队列里 */
  async function pushToGit() {
    const targets = pushTargets;
    if (!targets.length) {
      error = '没有待推送的内容：先编辑一篇，或点「保存本地」暂存';
      return;
    }
    pushing = true;
    error = '';
    pushProblems = [];
    try {
      const d = await post<{
        data: {
          total: number;
          done: number;
          message: string;
          results: { path: string; ok: boolean; sha?: string; error?: string }[];
        };
      }>('/api/admin/content/batch', {
        files: targets.map((t) => ({
          path: t.path,
          front: t.front,
          body: t.body,
          content: t.content,
          ...(t.sha ? { sha: t.sha } : {}),
          notifySubscribers: t.notifySubscribers,
          message: `zero-cms: update ${t.path}`,
        })),
      });
      const okPaths = new Set(d.data.results.filter((r) => r.ok).map((r) => r.path));
      const failed = d.data.results.filter((r) => !r.ok);
      pushProblems = failed.map((r) => ({ path: r.path, error: r.error ?? '未知原因' }));
      drafts = drafts.filter((x) => !okPaths.has(x.path));
      // 正在编辑的这篇推上去了：把基准与 sha 对齐，否则会一直显示未保存 / 下次必冲突
      const mine = d.data.results.find((r) => r.ok && r.path === file);
      if (mine) {
        if (mine.sha) sha = mine.sha;
        baseForm = { ...form };
        baseBody = body;
      }
      notice = d.data.message + (failed.length ? `，${failed.length} 篇留在本地暂存` : '');
      setTimeout(() => (notice = ''), 6000);
      if (failed.length) showDrafts = true;
    } catch (e) {
      error = e instanceof Error ? e.message : '批量提交失败';
    } finally {
      pushing = false;
    }
  }

  function dropDraft(path: string) {
    drafts = removeDraft(drafts, path);
    pushProblems = pushProblems.filter((p) => p.path !== path);
  }

  /** 从队列里打开某一篇：先落好当前这篇的暂存，别把正在编辑的内容丢了 */
  async function openDraft(d: Draft) {
    if (file && dirty) saveLocal();
    try {
      const res = await get<{ data: { exists: boolean; content: string; sha: string } }>(
        `/api/admin/content/file?path=${encodeURIComponent(d.path)}`,
      );
      const parts = splitFrontMatter(res.data.content);
      file = d.path;
      doc = parseFront(parts.front);
      form = formFromDoc(doc);
      baseForm = { ...form };
      body = parts.body;
      baseBody = parts.body;
      sha = res.data.sha;
      const queuedDraft = draftOf(drafts, d.path);
      if (queuedDraft) {
        const qp = splitFrontMatter(queuedDraft.content);
        doc = parseFront(qp.front);
        form = formFromDoc(doc);
        body = qp.body;
        notice = '这篇用的是本地暂存的内容（还没推给仓库）';
        setTimeout(() => (notice = ''), 5000);
      } else {
        notice = '';
      }
      baseForm = { ...form };
      baseBody = body;
    } catch (e) {
      error = e instanceof Error ? e.message : '读取失败';
    }
  }

  const pathPreview = $derived.by(() => {
    const slug = canonSlug(newSlug || newTitle);
    const date = new Date().toISOString().slice(0, 10);
    return `${newDir}/${dated ? `${date}-` : ''}${slug || 'slug'}.md`;
  });

  let loading = $state(false);
  let error = $state('');
  let notice = $state('');

  // 顶部：发布后群发订阅
  let notifySubscribers = $state(false);

  // 新文章
  let showNew = $state(false);
  let newTitle = $state('');
  let newSlug = $state('');
  let newDir = $state('content/zh/posts');
  /** 后台「设置 → 内容仓库 → 文章目录」的值；非空时新建文章默认落这里，不再猜语言段 */
  let postsDirCfg = $state('');
  let dated = $state(false);

  // 分类 / 标签输入
  let catInput = $state('');
  let tagInput = $state('');

  // 封面图选择器
  let showCover = $state(false);
  // 正文「插入媒体」面板
  let showInsertMedia = $state(false);

  /* ---------------- 光标跟踪：短代码插到光标处，不改动 MarkdownEditor 本体 ---------------- */

  let area = $state<HTMLTextAreaElement | null>(null);
  let selStart = $state(0);
  let selEnd = $state(0);

  function capture(e: MouseEvent | KeyboardEvent) {
    const t = e.target;
    if (t instanceof HTMLTextAreaElement) {
      area = t;
      selStart = t.selectionStart;
      selEnd = t.selectionEnd;
    }
  }

  function insertShortcode(sc: Shortcode) {
    const live = area && area.isConnected ? area : null;
    const from = live ? live.selectionStart : body.length;
    const to = live ? live.selectionEnd : body.length;
    body = body.slice(0, from) + sc.text + body.slice(to);
    const i = sc.pick ? sc.text.indexOf(sc.pick) : -1;
    queueMicrotask(() => {
      const el = live ?? area;
      if (!el || !el.isConnected) return;
      el.focus();
      const a = i >= 0 ? from + i : from + sc.text.length;
      const b = i >= 0 ? a + sc.pick.length : a;
      el.setSelectionRange(a, b);
      selStart = a;
      selEnd = b;
    });
  }

  /** 在光标处插入一段文本（图片 ![]()、音视频按短代码），并把光标停在插入内容之后 */
  function insertFragment(text: string) {
    const live = area && area.isConnected ? area : null;
    const from = live ? live.selectionStart : body.length;
    const to = live ? live.selectionEnd : body.length;
    body = body.slice(0, from) + text + body.slice(to);
    queueMicrotask(() => {
      const el = live ?? area;
      if (!el || !el.isConnected) return;
      el.focus();
      const caret = from + text.length;
      el.setSelectionRange(caret, caret);
      selStart = caret;
      selEnd = caret;
    });
  }

  const IMG_RE = /\.(jpe?g|png|gif|webp|avif|svg)$/i;
  const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
  const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;

  /** 媒体库选中的地址按类型转成 Markdown 片段：图片 ![](url)，音视频走主题短代码 */
  function insertMedia(url: string) {
    const u = url.trim();
    if (!u) return;
    let frag: string;
    if (VIDEO_RE.test(u)) frag = `{{< video src="${u}" >}}\n`;
    else if (AUDIO_RE.test(u)) frag = `{{< audio src="${u}" >}}\n`;
    else if (IMG_RE.test(u)) frag = `![图片描述](${u})\n`;
    else frag = `[${u.split('/').pop() || '文件'}](${u})\n`;
    insertFragment(frag);
  }

  /* ---------------- 目录：只看文章，时刻目录整体屏蔽 ---------------- */

  /** 时刻目录（content/**\/moments/…）不属于文章页，浏览与新建都不给入口 */
  function isMomentPath(p: string): boolean {
    return p.split('/').includes('moments');
  }

  async function browse(path: string) {
    loading = true;
    error = '';
    try {
      const d = await get<{ data: Entry[] }>(`/api/admin/content?path=${encodeURIComponent(path)}`);
      entries = (d.data || []).filter((e) => !isMomentPath(e.path));
      dir = path;
      if (path === contentDir) {
        langDirs = entries.filter((e) => e.type === 'dir').map((e) => e.name);
        // 配了「文章目录」就以它为准，不再按语言段猜（扁平布局的站点没有 zh 这一层）
        if (!postsDirCfg && !langDirs.includes(newDir.split('/')[1] ?? '')) newDir = `${contentDir}/zh/posts`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : '无法读取内容目录，请确认已在设置页配置 Git 仓库并部署 GITHUB_TOKEN';
      entries = [];
    } finally {
      loading = false;
    }
  }

  async function openFile(entry: Entry) {
    if (entry.type === 'dir') {
      if (file && dirty && !confirm('当前文章有未保存的改动，确定离开？想留着就先点「保存本地」。')) return;
      void browse(entry.path);
      return;
    }
    if (dirty && !confirm('当前文章有未保存的改动。想留着就取消后点「保存本地」，确定则丢弃这些改动。')) return;
    loading = true;
    error = '';
    try {
      const d = await get<{ data: { exists: boolean; content: string; sha: string } }>(
        `/api/admin/content/file?path=${encodeURIComponent(entry.path)}`,
      );
      const parts = splitFrontMatter(d.data.content);
      file = entry.path;
      doc = parseFront(parts.front);
      form = formFromDoc(doc);
      baseForm = { ...form };
      body = parts.body;
      baseBody = parts.body;
      sha = d.data.sha;
      notice = d.data.exists ? '' : '（新文件，保存后写入仓库）';
    } catch (e) {
      error = e instanceof Error ? e.message : '读取文件失败';
    } finally {
      loading = false;
    }
  }

  /** 提交给后台的结构化字段：后端按 front + body 拼 Hugo 头 */
  function frontPayload(f: PostForm): Record<string, unknown> {
    const weight = String(f.weight ?? '').trim();
    return {
      title: f.title.trim(),
      subtitle: f.subtitle.trim(),
      date: fromDateInput(f.date),
      updated: fromDateInput(f.updated),
      summary: f.summary.trim(),
      description: f.description.trim(),
      categories: f.categories,
      tags: f.tags,
      image: f.image.trim(),
      draft: f.draft,
      weight: weight === '' ? null : Number(weight),
      pinned: f.pinned ? true : null,
      author: f.author.trim(),
      toc: f.toc,
      math: f.math,
    };
  }

  async function removeFile() {
    const queuedHere = draftOf(drafts, file);
    const extra = queuedHere ? '\n这篇还在本地暂存里，删除会一并从暂存移除（否则下次「保存到 Git」会把它又推回仓库）。' : '';
    if (!file || !confirm(`确定删除 ${file}？${extra}`)) return;
    try {
      await del(`/api/admin/content/file?path=${encodeURIComponent(file)}`);
      if (queuedHere) drafts = removeDraft(drafts, queuedHere.path);
      notice = '文件已删除';
      file = '';
      body = '';
      baseBody = '';
      form = emptyForm();
      baseForm = emptyForm();
      void browse(dir);
    } catch (e) {
      error = e instanceof Error ? e.message : '删除失败';
    }
  }

  function newPost() {
    const slug = canonSlug(newSlug || newTitle);
    if (!newTitle.trim() || !slug) {
      error = '标题与 slug 必填';
      return;
    }
    if (isMomentPath(newDir)) {
      error = '文章页只写 posts 目录';
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const now = nowInput();
    file = `${newDir}/${dated ? `${date}-` : ''}${slug}.md`;
    doc = parseFront('');
    form = { ...emptyForm(), title: newTitle.trim(), date: now, updated: now };
    baseForm = emptyForm();
    body = '正文从这里开始。站内引用另一篇文章直接写 `[[slug]]`。\n';
    baseBody = '';
    sha = '';
    notice = '新文件，保存后提交到仓库';
    showNew = false;
    error = '';
  }

  function addCat(raw: string) {
    const v = raw.trim();
    if (!v || form.categories.includes(v)) {
      catInput = '';
      return;
    }
    form.categories = [...form.categories, v];
    catInput = '';
  }

  function addTag(raw: string) {
    const v = raw.trim();
    if (!v || form.tags.includes(v)) {
      tagInput = '';
      return;
    }
    form.tags = [...form.tags, v];
    tagInput = '';
  }

  /** 先读配置拿内容目录，再打开目录树：只调一次，避免 $effect 反复触发 */
  async function boot() {
    try {
      const d = await get<{ data: Record<string, string> }>('/api/admin/config');
      contentDir = (d.data?.githubContentDir || 'content').replace(/\/+$/, '');
      postsDirCfg = (d.data?.githubPostsDir || '').trim().replace(/\/+$/, '');
    } catch {
      contentDir = 'content';
      postsDirCfg = '';
    }
    newDir = postsDirCfg || `${contentDir}/zh/posts`;
    await browse(contentDir);
    void loadTranslate();
  }

  void boot();

  const postDirs = $derived(langDirs.map((l) => `${contentDir}/${l}/posts`));
  const crumbs = $derived(dir.split('/').filter(Boolean));

  /* ---------------- 机器翻译：只出草稿，确认后才落进表单 ---------------- */

  interface TrStatus {
    provider: string;
    model: string;
    ready: boolean;
    hint: string;
  }

  let tr = $state<TrStatus | null>(null);
  let trBusy = $state(false);
  let trDraft = $state('');
  let trNote = $state('');

  async function loadTranslate() {
    try {
      const d = await get<{ data: TrStatus }>('/api/admin/translate/status');
      tr = d.data;
    } catch {
      tr = null;
    }
  }

  async function runTranslate() {
    if (!body.trim()) {
      trNote = '正文是空的，没什么可译。';
      return;
    }
    trBusy = true;
    trNote = '';
    trDraft = '';
    try {
      const d = await post<{ data: { results: { ok: boolean; text: string; error?: string }[] } }>(
        '/api/admin/translate',
        { text: body },
      );
      const r = d.data.results[0];
      if (!r?.ok) trNote = r?.error || '翻译服务没返回内容';
      else trDraft = r.text;
    } catch (e) {
      trNote = e instanceof Error ? e.message : '翻译失败';
    } finally {
      trBusy = false;
    }
  }

  function appendDraft() {
    body = `${body.replace(/\s+$/, '')}\n\n${trDraft}\n`;
    trDraft = '';
  }

  function fillDescription() {
    form.description = trDraft.replace(/\s+/g, ' ').trim().slice(0, 300);
    trDraft = '';
  }
</script>

<div class="row spread head">
  <h2>文章</h2>
  <div class="row">
    <button onclick={() => (showNew = !showNew)}>＋ 新文章</button>
    <button onclick={() => void browse(dir)} disabled={loading}>{loading ? '读取中…' : '刷新目录'}</button>
    <button class="ghost" onclick={() => (showDrafts = !showDrafts)} aria-expanded={showDrafts}>
      本地暂存{queued ? ` ${queued}` : ''}
    </button>
    {#if !queued && dirty}<button class="primary" onclick={saveLocal}>保存本地</button>{/if}
    <button class="primary" onclick={() => void pushToGit()} disabled={pushing || !pushTargets.length} title="把本地暂存的文章一次全部推送到仓库；没有暂存时只推送正在编辑的这一篇">
      {pushing ? '推送中…' : queued ? `保存到 Git（${queued}）` : '保存到 Git'}
    </button>
  </div>
</div>

{#if showDrafts}
  <div class="card drafts">
    <div class="row spread">
      <h3>本地暂存（{queued} 篇）</h3>
      <span class="muted small">存在这台浏览器的 localStorage 里，没有进仓库；换浏览器 / 清缓存会丢，攒着不如早点推。</span>
    </div>
    {#if !queued}
      <p class="muted">还没有暂存。编辑文章后点编辑器里的「保存本地」，可以一篇一篇改，最后一起推。</p>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>标题</th><th>文件</th><th>暂存于</th><th>群发</th><th></th></tr>
          </thead>
          <tbody>
            {#each drafts as d (d.path)}
              <tr>
                <td>
                  <button class="sm ghost" onclick={() => void openDraft(d)} title="用本地暂存的这份内容打开它">
                    {d.title || '（无标题）'}
                  </button>
                </td>
                <td class="muted small">{d.path}</td>
                <td class="muted small">{formatSavedAt(d.savedAt)}</td>
                <td class="muted small">{d.notifySubscribers ? '推送后群发' : '—'}</td>
                <td>
                  <div class="row">
                    {#if pushProblems.some((p) => p.path === d.path)}<span class="warn">未推上去</span>{/if}
                    {#if d.path === file && dirty}<span class="muted small">编辑器里还有更新的改动</span>{/if}
                    <button class="sm" onclick={() => void openDraft(d)}>打开</button>
                    <button class="sm danger" onclick={() => dropDraft(d.path)}>移除</button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if pushProblems.length}
      <p class="err">
        这 {pushProblems.length} 篇没推上去，仍在暂存里：
        {#each pushProblems as p (p.path)}<br />· {p.path} —— {p.error}{/each}
        <br />冲突的那篇请先「打开」核对内容再推。
      </p>
    {/if}
  </div>
{/if}

<div class="card topbar">
  <label class="switch">
    <input type="checkbox" bind:checked={notifySubscribers} />
    <span>发布后群发订阅</span>
  </label>
  <span class="muted small">勾选后本次保存会请求后端向已确认订阅者推送本文（notifySubscribers）。</span>
  {#if file}<code class="path" title={file}>{file}</code>{/if}
</div>

{#if showNew}
  <div class="card new">
    <div class="row">
      <input placeholder="标题" bind:value={newTitle} />
      <input placeholder="slug（文件名，可中文）" bind:value={newSlug} />
      <select bind:value={newDir}>
        {#each postDirs as d (d)}<option value={d}>{d}</option>{/each}
        {#if !postDirs.includes(newDir)}<option value={newDir}>{newDir}</option>{/if}
      </select>
      <label class="switch inline">
        <input type="checkbox" bind:checked={dated} />
        <span>文件名带日期</span>
      </label>
      <button class="primary" onclick={newPost}>创建</button>
    </div>
    <p class="muted">将生成 {pathPreview} 并打开结构化表单。文章页只写 posts 目录，时刻请在「时刻」页发布。</p>
  </div>
{/if}

{#if error}<p class="err">{error}</p>{/if}

<div class="split">
  <div class="card files">
    <div class="crumbs muted">
      {#each crumbs as c, i}
        {#if i > 0} / {/if}
        <button class="crumb" onclick={() => void browse(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
      {/each}
    </div>
    {#if !entries.length && !loading}<p class="muted">目录为空</p>{/if}
    {#each entries as e (e.path)}
      <button class="entry" class:active={file === e.path} onclick={() => void openFile(e)}>
        <span>{e.type === 'dir' ? '📁' : e.name.endsWith('.md') ? '📄' : '🗎'}</span>
        <span class="nm">{e.name}</span>
        {#if e.size}<span class="sz">{(e.size / 1024).toFixed(1)}KB</span>{/if}
      </button>
    {/each}
  </div>

  <div class="editor">
    {#if file}
      <div class="card pane">
        <div class="row spread">
          <span class="muted small">{notice || '结构化编辑：「保存本地」只存这台浏览器，右上角「保存到 Git」才进仓库'}</span>
          <div class="row">
            {#if dirty}<span class="warn">未保存</span>{/if}
            {#if draftOf(drafts, file)}<span class="muted small">已在本地暂存</span>{/if}
            <button class="sm danger" onclick={removeFile}>删除</button>
            <button class="sm primary" onclick={saveLocal} disabled={!file}>保存本地</button>
          </div>
        </div>

        <div class="grid2">
          <label>标题<input bind:value={form.title} placeholder="文章标题" /></label>
          <label>副标题<input bind:value={form.subtitle} placeholder="列表页展示的副标题，可留空" /></label>
        </div>

        <div class="grid2">
          <label>发布时间<input type="datetime-local" bind:value={form.date} /></label>
          <label>修改时间<input type="datetime-local" bind:value={form.updated} placeholder="留空则不写 lastmod" /></label>
        </div>

        <label>摘要（summary）<textarea rows="2" bind:value={form.summary} placeholder="主题列表页的简述，没有就留空"></textarea></label>
        <label>描述（description）<textarea rows="2" bind:value={form.description} placeholder="SEO / OG 描述"></textarea></label>

        <div class="grid2">
          <div class="block">
            <span class="lbl">分类（多个）</span>
            <div class="chips">
              {#each form.categories as c, i (c)}
                <button class="chip on" title="点击移除" onclick={() => (form.categories = form.categories.filter((_, x) => x !== i))}>
                  {c} ✕
                </button>
              {/each}
            </div>
            <div class="row addrow">
              <input placeholder="回车或点添加" bind:value={catInput} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addCat(catInput))} />
              <button class="sm" onclick={() => addCat(catInput)}>添加分类</button>
            </div>
          </div>

          <div class="block">
            <span class="lbl">标签（多个）</span>
            <div class="chips">
              {#each form.tags as t, i (t)}
                <button class="chip on" title="点击移除" onclick={() => (form.tags = form.tags.filter((_, x) => x !== i))}>
                  {t} ✕
                </button>
              {/each}
            </div>
            <div class="row addrow">
              <input placeholder="回车或点添加" bind:value={tagInput} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag(tagInput))} />
              <button class="sm" onclick={() => addTag(tagInput)}>添加标签</button>
            </div>
          </div>
        </div>

        <div class="block">
          <span class="lbl">封面图（image）</span>
          <div class="row">
            <input class="grow" placeholder="https://… 或从媒体库选择" bind:value={form.image} />
            <button class="sm" onclick={() => (showCover = true)}>从媒体库选</button>
            {#if form.image}<button class="sm ghost" onclick={() => (form.image = '')}>清除</button>{/if}
          </div>
          {#if form.image}<img class="cover" src={form.image} alt="封面预览" loading="lazy" />{/if}
        </div>

        <div class="row toggles">
          <label class="switch">
            <input type="checkbox" bind:checked={form.draft} />
            <span>草稿（勾上只存进仓库，前台不渲染；取消勾选才发布）</span>
          </label>
          <label class="switch">
            <input type="checkbox" bind:checked={form.pinned} />
            <span>置顶（首页精选排在前）</span>
          </label>
          <label class="wgt">
            weight
            <input
              type="number"
              value={form.weight}
              oninput={(e) => (form.weight = e.currentTarget.value)}
              placeholder="10"
              title="Hugo 按 weight 升序排，越小越靠前；留空表示不写"
            />
          </label>
          <label class="switch">
            <input type="checkbox" bind:checked={form.toc} />
            <span>目录 toc</span>
          </label>
          <label class="switch">
            <input type="checkbox" bind:checked={form.math} />
            <span>公式 math</span>
          </label>
        </div>

        <div class="grid2">
          <label>作者标识（author）<input bind:value={form.author} placeholder="与用户作者的 handle 一致" /></label>
          <div class="block"></div>
        </div>

        <div class="body" role="presentation" onclick={capture} onkeyup={capture}>
          <ShortcodeBar oninsert={insertShortcode} onmedia={() => (showInsertMedia = true)} />
          <MarkdownEditor bind:value={body} rows={20} placeholder="Markdown 正文…" />
        </div>

        {#if tr?.ready}
          <div class="tr">
            <div class="row">
              <span class="muted small">机器翻译 · {tr.provider} {tr.model} · 译为简体中文</span>
              <button class="sm" onclick={() => void runTranslate()} disabled={trBusy}>
                {trBusy ? '翻译中…' : '译成草稿'}
              </button>
              {#if trDraft}
                <button class="sm ghost" onclick={appendDraft}>追加到正文</button>
                <button class="sm ghost" onclick={fillDescription}>填入描述</button>
                <button class="sm ghost" onclick={() => (trDraft = '')}>丢弃</button>
              {/if}
              <a class="muted small" href="/translate">去「翻译」页做多段翻译 →</a>
            </div>
            {#if trNote}<p class="err small">{trNote}</p>{/if}
            {#if trDraft}<textarea rows="5" bind:value={trDraft} placeholder="译稿"></textarea>{/if}
          </div>
        {:else if tr && tr.provider !== 'none' && tr.hint}
          <p class="muted small">机器翻译暂不可用：{tr.hint}（到「设置 - 机器翻译」调整）</p>
        {/if}
      </div>
    {:else}
      <div class="card placeholder">
        <p class="muted">从左侧选择一个 .md 文件进行编辑，或点击「新文章」。</p>
        <p class="muted">保存即通过 GitHub Contents API 提交到仓库，Actions 会自动重建站点。</p>
      </div>
    {/if}
  </div>
</div>

<MediaPicker bind:open={showCover} title="选择封面图" onpick={(url) => (form.image = url)} />
<MediaPicker bind:open={showInsertMedia} title="插入媒体" kind="any" onpick={insertMedia} />

<style>
  .head {
    margin-bottom: 0.8rem;
  }
  /* 本地暂存面板：表格式列表 + 结果提示，间距与其余卡片一致 */
  .drafts {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.8rem;
  }
  .drafts h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex-wrap: wrap;
    margin-bottom: 0.8rem;
    padding: 0.6rem 0.9rem;
  }
  .topbar .path {
    margin-left: auto;
    font-size: 0.78rem;
    color: var(--muted);
    min-width: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new {
    margin-bottom: 0.8rem;
  }
  .new p {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
  }
  .split {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 0.9rem;
    align-items: start;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 74vh;
    overflow: auto;
    padding: 0.6rem;
  }
  .crumbs {
    font-size: 0.8rem;
    padding: 0.2rem 0.3rem 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    align-items: center;
  }
  .crumb {
    border: none;
    background: none;
    padding: 0;
    font-size: 0.8rem;
    color: var(--accent);
    cursor: pointer;
  }
  .entry {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    border: none;
    background: none;
    text-align: left;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
    width: 100%;
  }
  .entry:hover {
    background: var(--accent-soft);
    color: var(--fg);
    border-color: transparent;
  }
  .entry.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sz {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .pane {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.6rem;
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
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    min-height: 24px;
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
  .addrow input {
    flex: 1;
    min-width: 140px;
  }
  .grow {
    flex: 1;
    min-width: 220px;
  }
  .cover {
    max-height: 148px;
    border-radius: 8px;
    border: 1px solid var(--border);
    object-fit: cover;
    align-self: flex-start;
  }
  .toggles {
    gap: 1rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.86rem;
    color: var(--fg);
  }
  .switch.inline {
    font-size: 0.8rem;
  }
  .switch input {
    width: 16px;
    height: 16px;
  }
  .wgt {
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
  }
  .wgt input {
    width: 88px;
    padding: 0.2rem 0.4rem;
  }
  .small {
    font-size: 0.76rem;
  }
  .path {
    font-size: 0.82rem;
    color: var(--muted);
  }
  .placeholder {
    padding: 3rem 2rem;
    text-align: center;
  }
  .tr {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.7rem;
    padding-top: 0.7rem;
    border-top: 1px solid var(--border, #e5e7eb);
  }
  .tr textarea {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.84rem;
    line-height: 1.6;
  }
  @media (max-width: 900px) {
    .split {
      grid-template-columns: 1fr;
    }
  }
</style>
