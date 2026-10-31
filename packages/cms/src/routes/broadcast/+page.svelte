<script lang="ts">
  import { flash } from '#lib/toast.svelte';
  import { del, get, post } from '#lib/api';
  import { fmtDate, timeAgo } from '#lib/api';
  import MarkdownEditor from '#lib/MarkdownEditor.svelte';
  import { renderMarkdown } from '#lib/markdown';
  import { frontUrl } from '#lib/session.svelte';

  interface Log {
    id: string;
    to: string;
    subject: string;
    status: string;
    error: string | null;
    /** 发信服务器原文回执（SMTP 各步应答 + 最后那条 250，内含 queued as 的队列号） */
    detail: string | null;
    postId: string | null;
    createdAt: number;
    sentAt: number | null;
  }

  interface PostItem {
    id: string;
    path: string;
    title: string;
  }

  interface Job {
    id: string;
    subject: string;
    postId: string | null;
    postPath: string | null;
    scheduleAt: number | null;
    status: string;
    recipientCount: number;
    sentCount: number;
    failedCount: number;
    error: string | null;
    createdAt: number;
    finishedAt: number | null;
  }

  /** POST /api/admin/subscribe/push 的结果：ran=false 时 reason 就是「为什么一封都没发」 */
  interface PushOutcome {
    ran: boolean;
    reason: string;
    newPosts: string[];
    recipients: number;
    queued: number;
    baseline: boolean;
  }

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  let subject = $state('');
  let md = $state('');
  let htmlMode = $state(false);
  let htmlText = $state('');
  let postPath = $state(''); // 下拉选中项（以 path 作 value）
  let scheduleAt = $state(''); // datetime-local 字符串
  let previewing = $state(false);
  let sending = $state(false);
  let error = $state('');
  let notice = $state('');
  /* 顶部那行结果提示改走右上角浮层（页面一长就看不见那行小字） */
  flash('err', () => error);
  flash('ok', () => notice);

  let confirmed = $state(0);
  let logs = $state<Log[]>([]);
  let pushing = $state(false);

  let posts = $state<PostItem[]>([]);
  let postsLoading = $state(false);
  let postsError = $state('');
  let jobs = $state<Job[]>([]);
  let jobsBusy = $state('');

  const bodyHtml = $derived(htmlMode ? htmlText : renderMarkdown(md, { shortBase: frontUrl('/posts/') || '/posts/' }));
  const ready = $derived(subject.trim().length > 0 && bodyHtml.trim().length > 0);

  /** 「关联文章」下拉用的已发布文章列表 */
  const selectedPost = $derived(posts.find((p) => p.path === postPath) ?? null);

  function loadPosts() {
    postsLoading = true;
    postsError = '';
    get<{ data: unknown }>('/api/admin/posts')
      .then((d) => {
        const raw = d.data as { items?: PostItem[] } | PostItem[];
        const arr = Array.isArray(raw) ? raw : raw?.items ?? [];
        posts = arr.map((p) => ({
          id: p.id ?? p.path,
          path: p.path,
          title: p.title || p.path,
        }));
      })
      .catch((e) => {
        postsError = msg(e);
        posts = [];
      })
      .finally(() => (postsLoading = false));
  }

  function loadJobs() {
    get<{ data: Job[] }>('/api/admin/broadcast/jobs')
      .then((d) => (jobs = d.data || []))
      .catch(() => (jobs = []));
  }

  async function loadMeta() {
    error = '';
    try {
      const [subs, lg] = await Promise.all([
        get<{ data: { email: string }[] }>('/api/admin/subscribers?status=confirmed&limit=2000'),
        get<{ data: Log[] }>('/api/admin/email-logs'),
      ]);
      confirmed = subs.data.length;
      logs = lg.data;
    } catch (e) {
      error = msg(e);
    }
    loadPosts();
    loadJobs();
  }

  function scheduleStamp(): number | null {
    if (!scheduleAt) return null;
    const t = new Date(scheduleAt).getTime();
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }

  async function submit() {
    sending = true;
    error = '';
    notice = '';
    try {
      const stamp = scheduleStamp();
      const base: Record<string, unknown> = { subject: subject.trim(), html: bodyHtml };
      if (selectedPost) {
        base.postId = selectedPost.id;
        base.postPath = selectedPost.path;
      }
      if (stamp) {
        // 定时发送：创建任务，到点由后端 cron 执行（该接口尚未落地，见报告缺口）
        const d = await post<{ data: { id?: string } }>('/api/admin/broadcast/jobs', { ...base, scheduleAt: stamp });
        notice = `已创建定时任务${d.data?.id ? ` #${d.data.id.slice(0, 8)}` : ''}，将于 ${fmtDate(stamp)} 发送`;
        scheduleAt = '';
        loadJobs();
      } else {
        if (!confirm(`确认向 ${confirmed} 位已确认订阅者立即发送「${subject.trim()}」？`)) return;
        const d = await post<{ data: { recipients: number; queued: number } }>('/api/admin/broadcast', base);
        notice = `收件人 ${d.data.recipients} 位，已入队 ${d.data.queued} 封（未确认订阅者不会收到）`;
      }
      subject = '';
      md = '';
      htmlText = '';
      postPath = '';
      await loadMeta();
    } catch (e) {
      error = msg(e);
    } finally {
      sending = false;
    }
  }

  async function runJob(j: Job) {
    if (!confirm(`立即执行任务「${j.subject}」？`)) return;
    jobsBusy = j.id;
    error = '';
    try {
      await post(`/api/admin/broadcast/jobs/${j.id}/run`, {});
      loadJobs();
    } catch (e) {
      error = msg(e);
    } finally {
      jobsBusy = '';
    }
  }

  async function removeJob(j: Job) {
    /* 后端对「排队中」和「已经跑过的」两种任务是两种处理（前者改成已取消、后者真删），
       按钮只有一个，所以问句要说清按下之后列表里还有没有这一条。 */
    const ask = j.status === 'queued' ? `取消任务「${j.subject}」？（会留在列表里，标记为已取消）` : `删除任务「${j.subject}」？（这条记录会从列表里去掉）`;
    if (!confirm(ask)) return;
    jobsBusy = j.id;
    error = '';
    try {
      await del(`/api/admin/broadcast/jobs/${j.id}`);
      loadJobs();
    } catch (e) {
      error = msg(e);
    } finally {
      jobsBusy = '';
    }
  }

  /** 手动跑一次「新文章推送」：按 RSS 里比上次基线新的条目发 */
  async function pushNew(reset: boolean) {
    pushing = true;
    error = '';
    notice = '';
    try {
      const d = await post<{ data: PushOutcome }>('/api/admin/subscribe/push', { reset });
      const o = d.data;
      /* 后端一律回 200 + ran:false + 一句原因（开关关着 / RSS 抓不到 / 额度不够…），
         这里把那句人话原样摊开，别让人对着一坨 JSON 猜「推送到底跑没跑」。 */
      const tail = `${o.newPosts.length ? `新文章 ${o.newPosts.length} 篇；` : ''}${o.recipients ? `已确认订阅者 ${o.recipients} 位，入队 ${o.queued} 封` : '没有已确认订阅者'}`;
      if (!o.ran) error = `没有发出任何邮件：${o.reason}${tail ? `（${tail}）` : ''}`;
      else notice = `${o.reason}${o.baseline ? '（第一次跑只记基线，下一篇文章才会发信）' : ''}${tail ? ` · ${tail}` : ''}`;
      await loadMeta();
    } catch (e) {
      error = msg(e);
    } finally {
      pushing = false;
    }
  }

  $effect(() => void loadMeta());

  const jobBadge = (s: string) => (s === 'done' ? 'good' : s === 'failed' || s === 'canceled' ? 'bad' : 'pending');
  const jobZh = (s: string) =>
    ({ queued: '排队中', running: '发送中', done: '已完成', failed: '失败', canceled: '已取消' })[s] ?? s;
</script>

<div class="row spread head">
  <h2>邮件群发</h2>
  <div class="row">
    <span class="muted small">已确认订阅者 {confirmed} 位</span>
    <button class="sm" onclick={() => void loadMeta()}>刷新</button>
  </div>
</div>

<p class="muted small">
  邮件按 <code>siteUrl</code> 生成退订链接，收件人只包含已确认订阅者。发信不可用时这里会直接报错，不会假装发送成功。
  「新文章自动推送」是每天一次的定时任务（世界时 02:00）比站点 RSS 找新文章，最近一次跑成什么样在
  <a href="/">首页的「定时任务」表</a>里；想当场验证就点下面那两个按钮，结果会写明抓到的 RSS、几篇新文章、给几位订阅者入了队多少封。
</p>


<section class="card">
  <div class="fields">
    <label class="wide">
      主题
      <input bind:value={subject} maxlength="200" placeholder="每次发送都会带这个标题" />
    </label>

    <label class="wide">
      关联文章
      <select bind:value={postPath}>
        <option value="">不关联（手写正文）</option>
        {#if postsLoading}<option disabled value="">读取文章中…</option>{/if}
        {#each posts as p (p.path)}
          <option value={p.path}>{p.title} — {p.path}</option>
        {/each}
      </select>
      {#if postsError}
        <span class="err small">文章列表读取失败：{postsError}（后端需补 GET /api/admin/posts）</span>
      {:else if !posts.length && !postsLoading}
        <span class="muted small">没有可选的已发布文章。</span>
      {:else if selectedPost}
        <span class="muted small">将带 postId={selectedPost.id} · postPath={selectedPost.path}</span>
      {/if}
    </label>

    <label>
      定时发送（留空=立即）
      <input type="datetime-local" bind:value={scheduleAt} />
    </label>

    <label class="switch">
      <input type="checkbox" bind:checked={htmlMode} />
      <span>直接写 HTML</span>
    </label>
  </div>

  {#if htmlMode}
    <textarea rows="14" placeholder="<p>邮件正文</p>" bind:value={htmlText}></textarea>
  {:else}
    <MarkdownEditor bind:value={md} rows={14} shortBase={frontUrl('/posts/') || '/posts/'} placeholder={'用 Markdown 写正文，发送时自动转成邮件 HTML。\n\n支持标题、列表、引用、链接、**加粗**。'} />
  {/if}

  <div class="row acts">
    <button class="sm" onclick={() => (previewing = !previewing)}>{previewing ? '继续编辑' : '预览邮件'}</button>
    <span class="grow"></span>
    <button onclick={() => void pushNew(true)} disabled={pushing} title="只把基线推到最新，不补发历史">重置基线</button>
    <button onclick={() => void pushNew(false)} disabled={pushing}>{pushing ? '推送中…' : '推送新文章'}</button>
    {#if scheduleStamp()}
      <button class="primary" onclick={() => void submit()} disabled={sending || !ready}>
        {sending ? '创建中…' : '创建定时任务'}
      </button>
    {:else}
      <button class="primary" onclick={() => void submit()} disabled={sending || !ready || confirmed === 0}>
        {sending ? '发送中…' : `发给 ${confirmed} 位订阅者`}
      </button>
    {/if}
  </div>

  {#if previewing}
    <div class="mail">
      <div class="mail-head">
        <span class="muted">主题：</span>{subject || '（未填）'}
      </div>
      <div class="mail-body">{@html bodyHtml}</div>
      <p class="muted foot">每封邮件末尾会自动追加该收件人的专属退订链接。</p>
    </div>
  {/if}
</section>

<section class="card jobs">
  <div class="row spread">
    <h3>群发任务</h3>
    <button class="sm" onclick={loadJobs}>刷新任务</button>
  </div>
  {#if jobs.length === 0}
    <p class="muted small">还没有定时/群发任务。</p>
  {:else}
    <div class="table-wrap">
      <table class="cols-wide">
        <thead>
          <tr>
            <th>主题</th>
            <th>计划时间</th>
            <th>状态</th>
            <th>成功 / 失败</th>
            <th>说明</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each jobs as j (j.id)}
            <tr>
              <td class="clip">
                {j.subject}
                {#if j.postPath}<span class="muted small">{j.postPath}</span>{/if}
              </td>
              <td class="small muted">{j.scheduleAt ? fmtDate(j.scheduleAt) : '立即'}</td>
              <td><span class="badge {jobBadge(j.status)}">{jobZh(j.status)}</span></td>
              <td class="small">{j.sentCount} / {j.failedCount}{#if j.recipientCount}<span class="muted">（共 {j.recipientCount}）</span>{/if}</td>
              <td class="small err clip">{j.error || '—'}</td>
              <td class="ops">
                <button class="sm" onclick={() => void runJob(j)} disabled={jobsBusy === j.id}>立即执行</button>
                <button class="sm danger" onclick={() => void removeJob(j)} disabled={jobsBusy === j.id}>删除</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<section class="card logs">
  <h3>发信记录</h3>
  <p class="muted small">
    「已发送」只代表发信服务器收下了这封信（SMTP 回 250），不代表投进了对方收件箱。
    「说明」那列悬停能看发信服务器的原文回执，里面的 <code>queued as XXX</code> 是服务商的队列号，
    拿它去邮箱服务商的收发日志查，才能确定某一封信到底有没有出去、有没有被判垃圾。
    一行「排队中」长期不动，说明队列消费者没跑起来（跟发信配置无关）。
  </p>
  {#if logs.length === 0}
    <p class="muted small">还没有发信记录。</p>
  {:else}
    <div class="table-wrap">
      <table class="cols-wide">
        <thead>
          <tr>
            <th>收件人</th>
            <th>主题</th>
            <th>状态</th>
            <th>说明</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {#each logs as l (l.id)}
            <tr>
              <td>{l.to}</td>
              <td class="clip">{l.subject}</td>
              <td>
                <span class="badge {l.status === 'sent' ? 'good' : l.status === 'failed' ? 'bad' : 'pending'}">
                  {l.status === 'sent' ? '已发送' : l.status === 'failed' ? '失败' : '排队中'}
                </span>
              </td>
              <td class="clip" title={l.detail ?? ''}>{l.error || l.detail || (l.postId ? `文章 ${l.postId}` : '—')}</td>
              <td title={fmtDate(l.createdAt)}>{timeAgo(l.createdAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
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
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem 0.8rem;
    margin-bottom: 0.7rem;
    align-items: stretch;
  }
  /* 复选框不能被这条撑成 36px 的方块（它只该管文本框与下拉框） */
  .fields > label > input:not([type='checkbox']):not([type='radio']),
  .fields > label > select {
    width: 100%;
    height: var(--ctl-h);
  }
  .fields .wide {
    grid-column: 1 / -1;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    /* 这一格没有上方的标题文字：贴底对齐，高度就与旁边的输入框一样，
       不然 grid 的 stretch 会把它拉到「标题 + 控件」那么高 */
    align-self: end;
    min-height: var(--ctl-h);
    height: var(--ctl-h);
    padding: 0 0.65rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--fg);
    font-size: 0.86rem;
    white-space: nowrap;
  }
  .switch > input[type='checkbox'] {
    width: auto;
    height: auto;
    flex: none;
  }
  textarea {
    width: 100%;
  }
  @media (max-width: 720px) {
    .fields {
      grid-template-columns: 1fr;
    }
  }
  .acts {
    margin-top: 0.7rem;
  }
  .acts .grow {
    flex: 1;
  }
  .mail {
    margin-top: 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
  .mail-head {
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
    font-weight: 600;
  }
  .mail-body {
    padding: 1rem 1.1rem;
    line-height: 1.75;
  }
  .mail-body :global(a) {
    text-decoration: underline;
  }
  .foot {
    margin: 0;
    padding: 0.5rem 0.9rem;
    border-top: 1px dashed var(--border);
    font-size: 0.75rem;
  }
  .jobs,
  .logs {
    margin-top: 0.9rem;
  }
  .clip {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ops {
    white-space: nowrap;
  }
  .ops button + button {
    margin-left: 0.3rem;
  }
</style>
