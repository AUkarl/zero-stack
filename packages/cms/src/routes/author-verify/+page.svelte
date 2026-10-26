<script lang="ts">
  import { del, get, healthWarn, post, type BuildHealth } from '#lib/api';
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
    ['returned', '已退回'],
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
      /* 通过认证 = 整份重写 data/authors.yaml（Hugo 构建期读它）。
         这条路上线前既没请重建也没体检，接口只回「已通过」，写坏了没人报；
         现在结论在 authorFile.buildHealth 上，红的话用同一份 healthWarn 说人话。 */
      const d = await post<{ data?: { authorFile?: { ok: boolean; error?: string; buildHealth?: BuildHealth | null } } }>(
        `/api/admin/author-requests/${r.id}/approve`,
        {
          penName: form.penName.trim() || undefined,
          handle: handle || undefined,
          bio: form.bio.trim() || undefined,
          note: form.note.trim() || undefined,
        },
      );
      const af = d?.data?.authorFile;
      notice = `${form.penName.trim() || r.penName} 已通过认证${handle ? `，署名标识 ${handle}` : ''}`;
      if (af && !af.ok) error = `认证已通过，但作者表没写进去：${af.error ?? '未知原因'}`;
      const warn = af ? healthWarn(af.buildHealth) : '';
      if (warn) notice = `${notice} ${warn}`;
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

  /**
   * 退回给申请人改资料。只动这份申请单：他的认证徽章、作者标识、已发文章署名都不受影响，
   * 重新提交后这份回到「待核验」，再点一次通过就生效。
   */
  async function sendBack(r: ReqRow) {
    if (!form.note.trim() && !confirm('不填说明直接退回？用户在前台只会看到「站长已退回」，改什么最好写清楚。')) return;
    busy = r.id;
    error = '';
    try {
      await post(`/api/admin/author-requests/${r.id}/send-back`, { note: form.note.trim() });
      notice = `${r.penName} 的认证已退回，认证徽章保留；他改完重新提交会回到「待核验」`;
      open = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '退回失败';
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

  const STATUS_TEXT: Record<string, string> = { pending: '待核验', approved: '已通过', rejected: '已驳回', returned: '已退回' };
  const statusText = (s: string) => STATUS_TEXT[s] ?? s;
  /** 退回不是否定，视觉上跟「待核验」同色；红色只留给真驳回 */
  const statusCls = (s: string) => (s === 'approved' ? 'good' : s === 'rejected' ? 'bad' : 'pending');
</script>

<div class="row spread head">
  <h2>作者认证</h2>
  <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
</div>

<p class="muted small">
  通过后账号会拿到认证徽章，笔名与简介同时写入该账号；用户也可以在后台「用户」页单独勾选权限。
  「作者标识」是文章 front matter 里 author 写的那个值，也是作者页地址 /author/标识/ 的一段，只能用英文、数字和短横线；通过后该用户的投稿发布时会自动用它署名。
  已经通过的人想改笔名、简介、头像或联系方式：点开那份申请，按「退回改资料」——认证徽章、作者标识、已发文章的署名都不受影响，
  只是把申请单退回给他，他改完重新提交会回到「待核验」，再点一次通过就生效。
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
              <span class="badge {statusCls(r.status)}">{statusText(r.status)}</span>
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
                  <label class="full">审核备注<input bind:value={form.note} maxlength="500" placeholder="驳回或退回时建议写明缺什么、要改哪里" /></label>
                </div>
                <div class="row acts">
                  <span class="grow"></span>
                  <button class="sm" onclick={() => (open = null)}>取消</button>
                  {#if r.status === 'pending'}
                    <button class="sm danger" onclick={() => void reject(r)} disabled={busy === r.id}>驳回</button>
                  {/if}
                  {#if r.status === 'approved'}
                    <button class="sm" onclick={() => void sendBack(r)} disabled={busy === r.id}>退回改资料</button>
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
