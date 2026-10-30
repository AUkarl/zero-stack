<script lang="ts">
  import { del, get, post, patch, mailNote, purgeNote, type PurgeOut } from '#lib/api';
  import { fmtDate, timeAgo, healthWarn, type BuildHealth } from '#lib/api';
  import MarkdownEditor from '#lib/MarkdownEditor.svelte';
  import { frontUrl } from '#lib/session.svelte';

  interface DraftRow {
    id: string;
    userId: string;
    title: string;
    slug: string;
    category: string | null;
    tags: string[];
    summary: string | null;
    cover: string | null;
    status: string;
    reviewNote: string | null;
    publishedPath: string | null;
    publishedAt: number | null;
    createdAt: number;
    updatedAt: number;
    authorName: string | null;
    authorEmail: string | null;
  }

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  const TABS: [string, string][] = [
    ['pending', '待审'],
    ['draft', '草稿'],
    ['approved', '已通过'],
    ['withdraw_requested', '撤回申请'],
    ['rejected', '已驳回'],
    ['all', '全部'],
  ];

  let tab = $state('pending');
  let q = $state('');
  let rows = $state<DraftRow[]>([]);
  let total = $state(0);
  let stats = $state<Record<string, number>>({ draft: 0, pending: 0, approved: 0, rejected: 0, withdraw_requested: 0, total: 0 });
  let loading = $state(false);
  let error = $state('');
  let notice = $state('');
  let busy = $state('');

  // 展开的那篇：正文与可编辑字段单独取，列表接口不带长文本
  let open = $state<DraftRow | null>(null);
  let edit = $state({ title: '', category: '', tags: '', summary: '', cover: '', content: '' });
  let note = $state('');
  let publish = $state(true);
  let savingEdit = $state(false);

  async function load() {
    loading = true;
    error = '';
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      if (q.trim()) params.set('q', q.trim());
      const [list, st] = await Promise.all([
        get<{ data: { items: DraftRow[]; total: number } }>(`/api/admin/drafts?${params}`),
        get<{ data: Record<string, number> }>('/api/admin/drafts/stats'),
      ]);
      rows = list.data.items;
      total = list.data.total;
      stats = { ...stats, ...st.data };
    } catch (e) {
      error = msg(e);
    } finally {
      loading = false;
    }
  }

  async function openDraft(r: DraftRow) {
    if (open?.id === r.id) {
      open = null;
      return;
    }
    busy = r.id;
    error = '';
    note = '';
    publish = true;
    try {
      const d = await get<{ data: DraftRow & { content: string } }>(`/api/admin/drafts/${r.id}`);
      const full = d.data;
      edit = {
        title: full.title ?? '',
        category: full.category ?? '',
        tags: (full.tags ?? []).join(', '),
        summary: full.summary ?? '',
        cover: full.cover ?? '',
        content: full.content ?? '',
      };
      open = r;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  /** PATCH 保存对标题/分类/标签/摘要/封面/正文的修改（后端接口需补，见报告缺口） */
  async function saveEdit() {
    if (!open) return;
    if (!edit.title.trim()) {
      error = '标题必填';
      return;
    }
    savingEdit = true;
    error = '';
    notice = '';
    try {
      const tags = edit.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20);
      const body = {
        title: edit.title.trim(),
        category: edit.category.trim() || null,
        tags,
        summary: edit.summary.trim() || null,
        cover: edit.cover.trim() || null,
        content: edit.content,
      };
      await patch(`/api/admin/drafts/${open.id}`, body);
      notice = '修改已保存';
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      savingEdit = false;
    }
  }

  async function approve(r: DraftRow) {
    busy = r.id;
    error = '';
    try {
      const d = await post<{
        data: {
          synced: boolean;
          syncError: string | null;
          path: string | null;
          state?: 'sent' | 'queued' | 'failed';
          notifyError?: string | null;
          buildHealth?: BuildHealth | null;
        };
      }>(`/api/admin/drafts/${r.id}/approve`, { publish, note: note.trim() || undefined });
      /* 投稿的 front matter 是投稿人填的：日期写成 Hugo 认不了的样子会让整站构建失败。
         审核这一笔以前只说「已通过并写入」，站点停了没人知道（R58 补上）。 */
      notice =
        (d.data.synced ? `已通过并写入 ${d.data.path}` : `已通过，未写入仓库：${d.data.syncError ?? '检查「设置 → 内容仓库」的 owner / repo / 目录与 GITHUB_TOKEN'}`) +
        mailNote(d.data) +
        healthWarn(d.data.buildHealth);
      open = null;
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  async function reject(r: DraftRow) {
    if (!note.trim() && !confirm('不填理由直接驳回？作者会看到一条没有说明的驳回。')) return;
    busy = r.id;
    error = '';
    try {
      await post(`/api/admin/drafts/${r.id}/reject`, note.trim() ? { note: note.trim() } : {});
      notice = `《${r.title}》已驳回`;
      open = null;
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  /** 已通过但没落到仓库的，补一次提交 */
  async function republish(r: DraftRow) {
    busy = r.id;
    error = '';
    notice = '';
    try {
      const d = await post<{ data: { path: string } }>(`/api/admin/drafts/${r.id}/publish`, {});
      notice = `已写入 ${d.data.path}`;
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  /** 同意作者撤回：删除仓库里已发布的文件并返回结果（后端接口需补，见报告缺口） */
  async function approveWithdraw(r: DraftRow) {
    if (!confirm(`同意撤回《${r.title}》？会删除仓库里已发布的那篇文章。`)) return;
    busy = r.id;
    error = '';
    notice = '';
    try {
      const d = await post<{ data: { deleted: boolean; path: string | null; error: string | null; purge: PurgeOut | null } }>(
        `/api/admin/drafts/${r.id}/withdraw`,
        {},
      );
      notice = d.data.deleted
        ? `已撤回并删除仓库文件 ${d.data.path ?? ''}${purgeNote(d.data.purge)}`
        : `撤回失败：${d.data.error ?? '未知原因'}`;
      open = null;
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  async function rejectWithdraw(r: DraftRow) {
    if (!note.trim() && !confirm('不填理由驳回撤回申请？文章将保持已发布。')) return;
    busy = r.id;
    error = '';
    try {
      await post(`/api/admin/drafts/${r.id}/withdraw-reject`, note.trim() ? { note: note.trim() } : {});
      notice = `《${r.title}》的撤回申请已驳回`;
      open = null;
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  async function remove(r: DraftRow) {
    if (!confirm(`删除《${r.title}》？这条投稿会从库里清掉。`)) return;
    busy = r.id;
    error = '';
    try {
      await del(`/api/admin/drafts/${r.id}`);
      open = null;
      await load();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  $effect(() => void load());

  const canReview = (r: DraftRow) => r.status === 'pending' || r.status === 'draft';
  const isWithdraw = (r: DraftRow) => r.status === 'withdraw_requested';
  const statusBadge = (r: DraftRow) =>
    r.status === 'approved'
      ? 'good'
      : r.status === 'rejected' || r.status === 'withdraw_requested'
        ? r.status === 'withdraw_requested'
          ? 'pending'
          : 'bad'
        : r.status === 'pending'
          ? 'pending'
          : '';
  const statusText = (r: DraftRow) =>
    r.status === 'approved'
      ? r.publishedPath
        ? '已发布'
        : '待写入'
      : r.status === 'rejected'
        ? '已驳回'
        : r.status === 'withdraw_requested'
          ? '申请撤回'
          : r.status === 'pending'
            ? '待审'
            : '草稿';
</script>

<div class="row spread head">
  <h2>投稿审核</h2>
  <div class="row">
    <input class="search" placeholder="按标题 / 文件名筛选" bind:value={q} onkeydown={(e) => e.key === 'Enter' && load()} />
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
  </div>
</div>

<div class="tabs">
  {#each TABS as [key, label] (key)}
    <button class="tab" class:on={tab === key} onclick={() => { tab = key; open = null; void load(); }}>
      {label} <span class="n">{key === 'all' ? stats.total ?? 0 : stats[key] ?? 0}</span>
    </button>
  {/each}
  <span class="muted small right">共 {total} 条</span>
</div>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

<div class="card">
  <div class="table-wrap">
    <table class="cols-wide">
      <thead>
        <tr>
          <th>标题</th>
          <th>文件名</th>
          <th>作者</th>
          <th>分类 / 标签</th>
          <th>状态</th>
          <th>提交于</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.id)}
          <tr>
            <td>{r.title}</td>
            <td class="mono">{r.slug.startsWith('draft-') ? '发布时自动命名' : r.slug}</td>
            <td>{r.authorName || '—'}<span class="muted small">{r.authorEmail ?? ''}</span></td>
            <td class="clip">{[r.category, ...r.tags].filter(Boolean).join(' · ') || '—'}</td>
            <td><span class="badge {statusBadge(r)}">{statusText(r)}</span></td>
            <td title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
            <td class="ops">
              <button class="sm" onclick={() => openDraft(r)} disabled={busy === r.id}>{open?.id === r.id ? '收起' : '查看/编辑'}</button>
              {#if canReview(r)}
                <button class="sm" onclick={() => void remove(r)} disabled={busy === r.id}>删</button>
              {:else if r.status === 'approved' && !r.publishedPath}
                <button class="sm" onclick={() => void republish(r)} disabled={busy === r.id}>补发</button>
              {/if}
            </td>
          </tr>
          {#if open?.id === r.id}
            <tr class="detail">
              <td colspan="8">
                <div class="meta">
                  {#if r.publishedPath}<span class="muted small">已写入 {r.publishedPath}</span>{/if}
                  {#if r.reviewNote}<span class="muted small">上次备注：{r.reviewNote}</span>{/if}
                  <span class="muted small">作者邮箱：{r.authorEmail || '—'}</span>
                </div>

                <div class="grid">
                  <label class="full">标题 *<input bind:value={edit.title} maxlength="120" /></label>
                  <label>分类<input bind:value={edit.category} maxlength="60" /></label>
                  <label>标签（逗号分隔）<input bind:value={edit.tags} placeholder="tag1, tag2" /></label>
                  <label class="full">摘要<input bind:value={edit.summary} maxlength="300" /></label>
                  <label class="full">封面地址<input bind:value={edit.cover} placeholder="https://…/cover.png" /></label>
                </div>

                <p class="bodylabel">正文 Markdown</p>
                <MarkdownEditor bind:value={edit.content} rows={12} placeholder="投稿正文" plainLinks shortBase={frontUrl('/posts/') || '/posts/'} />

                <div class="row acts">
                  <button class="sm primary" onclick={() => void saveEdit()} disabled={savingEdit || busy === r.id}>
                    {savingEdit ? '保存中…' : '保存修改'}
                  </button>
                  <span class="grow"></span>

                  {#if canReview(r)}
                    <label class="switch">
                      <input type="checkbox" bind:checked={publish} />
                      <span>通过后立即写入仓库并触发重建</span>
                    </label>
                    <button class="sm danger" onclick={() => void reject(r)} disabled={busy === r.id}>驳回</button>
                    <button class="sm primary" onclick={() => void approve(r)} disabled={busy === r.id}>
                      {busy === r.id ? '处理中…' : '通过'}
                    </button>
                  {:else if isWithdraw(r)}
                    <button class="sm" onclick={() => void rejectWithdraw(r)} disabled={busy === r.id}>驳回撤回</button>
                    <button class="sm primary" onclick={() => void approveWithdraw(r)} disabled={busy === r.id}>
                      {busy === r.id ? '处理中…' : '同意撤回（删仓库文件）'}
                    </button>
                  {:else if r.status === 'approved'}
                    <button class="sm" onclick={() => void republish(r)} disabled={busy === r.id}>补发</button>
                  {/if}
                </div>

                {#if canReview(r) || isWithdraw(r)}
                  <div class="row note">
                    <input class="wide" placeholder={isWithdraw(r) ? '驳回撤回的理由（作者可见，选填）' : '审核备注（驳回时作者可见）'} bind:value={note} maxlength="500" />
                  </div>
                {/if}
              </td>
            </tr>
          {/if}
        {:else}
          <tr><td colspan="8" class="muted">{loading ? '加载中…' : '这个状态下没有投稿'}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .head {
    margin-bottom: 0.5rem;
  }
  .tabs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.7rem;
  }
  .tab {
    padding: 0.24rem 0.75rem;
    font-size: 0.84rem;
    border-radius: 999px;
  }
  .tab.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .tab .n {
    opacity: 0.75;
    font-size: 0.76rem;
  }
  .right {
    margin-left: auto;
  }
  .small {
    font-size: 0.76rem;
  }
  .search {
    width: 220px;
  }
  .mono {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.78rem;
  }
  .clip {
    max-width: 200px;
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
  .detail td {
    background: var(--panel-2);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    align-items: baseline;
    font-size: 0.82rem;
    padding: 0.2rem 0 0.4rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 0.6rem;
    padding: 0.3rem 0;
  }
  .full {
    grid-column: 1 / -1;
  }
  .bodylabel {
    margin: 0.3rem 0;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .acts {
    margin-top: 0.6rem;
  }
  .acts .grow {
    flex: 1;
  }
  .note {
    margin-top: 0.5rem;
  }
  .note .wide {
    flex: 1;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    color: var(--fg);
    font-size: 0.84rem;
  }
</style>
