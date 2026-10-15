<script lang="ts">
  import { del, get, post } from '#lib/api';
  import { fmtDate, timeAgo } from '#lib/api';

  interface Social {
    platform: string;
    handle: string;
    proof?: string;
  }

  interface ReqRow {
    id: string;
    userId: string;
    penName: string;
    bio: string | null;
    social: Social[];
    reason: string | null;
    status: string;
    adminNote: string | null;
    reviewedAt: number | null;
    createdAt: number;
    authorName: string | null;
    authorEmail: string | null;
    authorHandle: string | null;
    authorVerified: boolean;
  }

  const TABS: [string, string][] = [
    ['pending', '待核验'],
    ['approved', '已通过'],
    ['rejected', '已驳回'],
    ['all', '全部'],
  ];

  let tab = $state('pending');
  let rows = $state<ReqRow[]>([]);
  let loading = $state(false);
  let error = $state('');
  let notice = $state('');
  let busy = $state('');

  let open = $state<ReqRow | null>(null);
  let form = $state({ penName: '', bio: '', note: '', handle: '' });

  async function load() {
    loading = true;
    error = '';
    try {
      const params = tab !== 'all' ? `?status=${tab}` : '';
      const d = await get<{ data: { items: ReqRow[] } }>(`/api/admin/author-requests${params}`);
      rows = d.data.items;
    } catch (e) {
      error = e instanceof Error ? e.message : '读取失败';
    } finally {
      loading = false;
    }
  }

  function startReview(r: ReqRow) {
    open = r;
    form = { penName: r.penName, bio: r.bio ?? '', note: '', handle: r.authorHandle ?? '' };
  }

  async function approve(r: ReqRow) {
    busy = r.id;
    error = '';
    try {
      const handle = form.handle.trim();
      await post(`/api/admin/author-requests/${r.id}/approve`, {
        penName: form.penName.trim() || undefined,
        handle: handle || undefined,
        bio: form.bio.trim() || undefined,
        note: form.note.trim() || undefined,
      });
      notice = `${form.penName.trim() || r.penName} 已通过认证${handle ? `，署名标识 ${handle}` : ''}`;
      open = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '通过失败';
    } finally {
      busy = '';
    }
  }

  async function reject(r: ReqRow) {
    if (!form.note.trim() && !confirm('不填理由直接驳回？')) return;
    busy = r.id;
    error = '';
    try {
      await post(`/api/admin/author-requests/${r.id}/reject`, { note: form.note.trim() });
      notice = `${r.penName} 的申请已驳回`;
      open = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '驳回失败';
    } finally {
      busy = '';
    }
  }

  async function remove(r: ReqRow) {
    if (!confirm('删除这条认证申请？记录会从库里清掉。')) return;
    busy = r.id;
    error = '';
    try {
      await del(`/api/admin/author-requests/${r.id}`);
      open = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '删除失败';
    } finally {
      busy = '';
    }
  }

  $effect(() => void load());
</script>

<div class="row spread head">
  <h2>作者认证</h2>
  <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
</div>

<p class="muted small">
  通过后账号会拿到认证徽章，笔名与简介同时写入该账号；用户也可以在后台「用户」页单独勾选权限。
  「作者标识」是文章 front matter 里 author 写的那个值，也是作者页地址 /author/标识/ 的一段，只能用英文、数字和短横线；通过后该用户的投稿发布时会自动用它署名。
</p>

<div class="tabs">
  {#each TABS as [key, label] (key)}
    <button class="tab" class:on={tab === key} onclick={() => { tab = key; open = null; void load(); }}>{label}</button>
  {/each}
</div>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

<div class="card">
  <div class="table-wrap">
    <table class="cols-wide">
      <thead>
        <tr>
          <th>笔名</th>
          <th>账号</th>
          <th>简介</th>
          <th>证明</th>
          <th>状态</th>
          <th>提交于</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.id)}
          <tr>
            <td>{r.penName}</td>
            <td class="clip">
              {r.authorName || '—'}<span class="muted small">{r.authorEmail ?? ''}{r.authorHandle ? ` @${r.authorHandle}` : ''}</span>
            </td>
            <td class="clip">{r.bio || '—'}</td>
            <td>{r.social.length} 项</td>
            <td>
              <span class="badge {r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'pending'}">
                {r.status === 'approved' ? '已通过' : r.status === 'rejected' ? '已驳回' : '待核验'}
              </span>
              {#if r.status === 'approved' && !r.authorVerified}
                <span class="badge pending">徽章已撤</span>
              {/if}
            </td>
            <td title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
            <td class="ops">
              <button class="sm" onclick={() => startReview(r)} disabled={busy === r.id}>核验</button>
              <button class="sm danger" onclick={() => void remove(r)} disabled={busy === r.id}>删</button>
            </td>
          </tr>
          {#if open?.id === r.id}
            <tr class="detail">
              <td colspan="7">
                {#if r.reason}<p class="reason">自述：{r.reason}</p>{/if}
                {#if r.social.length}
                  <ul class="social">
                    {#each r.social as s (s.platform + s.handle)}
                      <li>
                        <b>{s.platform}</b> {s.handle}
                        {#if s.proof}<span class="muted small">— {s.proof}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="muted small">没有填写任何社交平台证明。</p>
                {/if}
                {#if r.adminNote}<p class="muted small">上次备注：{r.adminNote}</p>{/if}
                <div class="grid">
                  <label>笔名<input bind:value={form.penName} maxlength="64" /></label>
                  <label>作者标识<input bind:value={form.handle} maxlength="40" placeholder="如 zhizhi，留空则不改" /></label>
                  <label class="full">简介<input bind:value={form.bio} maxlength="300" placeholder="通过后写入账号资料" /></label>
                  <label class="full">审核备注<input bind:value={form.note} maxlength="500" placeholder="驳回时建议写明缺什么证明" /></label>
                </div>
                <div class="row acts">
                  <span class="grow"></span>
                  <button class="sm" onclick={() => (open = null)}>取消</button>
                  {#if r.status === 'pending'}
                    <button class="sm danger" onclick={() => void reject(r)} disabled={busy === r.id}>驳回</button>
                  {/if}
                  <button class="sm primary" onclick={() => void approve(r)} disabled={busy === r.id}>
                    {busy === r.id ? '处理中…' : '通过认证'}
                  </button>
                </div>
              </td>
            </tr>
          {/if}
        {:else}
          <tr><td colspan="7" class="muted">{loading ? '加载中…' : '这个状态下没有申请'}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .head {
    margin-bottom: 0.3rem;
  }
  .tabs {
    display: flex;
    gap: 0.35rem;
    margin: 0.5rem 0 0.7rem;
  }
  .tab {
    padding: 0.24rem 0.75rem;
    font-size: 0.84rem;
    border-radius: 999px;
  }
  .tab.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .small {
    font-size: 0.76rem;
  }
  .clip {
    max-width: 220px;
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
    background: #fafafa;
  }
  .reason {
    margin: 0.1rem 0 0.4rem;
    font-size: 0.84rem;
    color: var(--fg);
  }
  .social {
    margin: 0 0 0.5rem;
    padding-left: 1.1rem;
    font-size: 0.82rem;
    line-height: 1.7;
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
  .acts {
    margin-top: 0.4rem;
  }
  .acts .grow {
    flex: 1;
  }
</style>
