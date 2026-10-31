<script lang="ts">
  import { del, fmtDate, get, post } from '#lib/api';

  interface Subscriber {
    id: string;
    email: string;
    status: 'pending' | 'confirmed' | 'unsubscribed';
    createdAt: number;
    confirmedAt: number | null;
    unsubscribedAt: number | null;
  }
  interface EmailLog {
    id: string;
    to: string;
    subject: string;
    status: 'queued' | 'sent' | 'failed';
    error: string | null;
    createdAt: number;
  }

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  const TABS = [
    { key: 'all', label: '全部' },
    { key: 'confirmed', label: '已确认' },
    { key: 'pending', label: '待确认' },
    { key: 'unsubscribed', label: '已退订' },
  ] as const;

  let tab = $state<(typeof TABS)[number]['key']>('confirmed');
  let subs = $state<Subscriber[]>([]);
  let logs = $state<EmailLog[]>([]);
  let loading = $state(false);
  let busy = $state('');
  let error = $state('');
  let notice = $state('');

  /**
   * 各状态各多少人。列表是按当前标签过滤过的，数不出全貌，所以每次一并取 status=all 的全量来数。
   * 「待确认」就是信已发到、但人还没点信里那个确认按钮 —— 这一栏解决的就是
   * 「订阅用户到底有没有点确认邮件」这件事：点了的人会挪进「已确认」并带上确认时间。
   */
  let counts = $state({ all: 0, confirmed: 0, pending: 0, unsubscribed: 0 });

  async function load() {
    loading = true;
    error = '';
    try {
      const [s, l, all] = await Promise.all([
        get<{ data: Subscriber[] }>(`/api/admin/subscribers?status=${tab}`),
        get<{ data: EmailLog[] }>('/api/admin/email-logs'),
        get<{ data: Subscriber[] }>('/api/admin/subscribers?status=all'),
      ]);
      subs = s.data || [];
      logs = l.data || [];
      const list = all.data || [];
      counts = {
        all: list.length,
        confirmed: list.filter((x) => x.status === 'confirmed').length,
        pending: list.filter((x) => x.status === 'pending').length,
        unsubscribed: list.filter((x) => x.status === 'unsubscribed').length,
      };
    } catch (e) {
      error = msg(e);
    } finally {
      loading = false;
    }
  }

  /** 直接确认一个可信邮箱，跳过双重确认邮件 */
  async function confirmSub(s: Subscriber) {
    if (!confirm(`把 ${s.email} 直接标记为已确认（可信邮箱）？`)) return;
    busy = s.id;
    error = '';
    try {
      await post(`/api/admin/subscribers/${s.id}/confirm`, {});
      notice = `${s.email} 已确认为可信邮箱`;
      await load();
      setTimeout(() => (notice = ''), 3000);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  async function unsubscribe(s: Subscriber) {
    if (!confirm(`把 ${s.email} 标记为已退订？退订后不再群发。`)) return;
    busy = s.id;
    error = '';
    try {
      await post(`/api/admin/subscribers/${s.id}/unsubscribe`, {});
      notice = `${s.email} 已取订`;
      await load();
      setTimeout(() => (notice = ''), 3000);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  async function remove(s: Subscriber) {
    if (!confirm(`删除订阅记录 ${s.email}？该邮箱需要重新订阅。`)) return;
    busy = s.id;
    error = '';
    try {
      await del(`/api/admin/subscribers/${s.id}`);
      notice = `已删除 ${s.email}`;
      await load();
      setTimeout(() => (notice = ''), 3000);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = '';
    }
  }

  function copyConfirmed() {
    const mails = subs.filter((s) => s.status === 'confirmed').map((s) => s.email).join('\n');
    if (!mails) {
      error = '当前列表没有已确认订阅者';
      return;
    }
    void navigator.clipboard.writeText(mails).then(
      () => {
        notice = `已复制 ${mails.split('\n').length} 个邮箱`;
        setTimeout(() => (notice = ''), 2500);
      },
      () => (error = '复制失败，请手动选取'),
    );
  }

  $effect(() => void load());

  const badgeCls = (s: string) => (s === 'confirmed' ? 'good' : s === 'unsubscribed' ? 'bad' : 'pending');
  const zhStatus = (s: string) => (s === 'confirmed' ? '已确认' : s === 'unsubscribed' ? '已退订' : '待确认');
</script>

<div class="row spread head">
  <h2>订阅者</h2>
  <div class="row">
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
    <button class="sm" onclick={copyConfirmed}>复制当前邮箱</button>
    <a class="btn primary" href="/broadcast">去群发 →</a>
  </div>
</div>

<p class="muted small">
  邮件群发与定时任务已挪到「<a href="/broadcast">群发</a>」页；这里只管理订阅者名单与发信日志。
</p>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

<div class="tabs">
  {#each TABS as t}
    <button class="sm {tab === t.key ? 'primary' : ''}" onclick={() => { tab = t.key; void load(); }}>{t.label}</button>
  {/each}
  <span class="muted small">当前 {subs.length} 条</span>
</div>

<p class="muted small">
  共 {counts.all} 个邮箱：已确认 <b>{counts.confirmed}</b>（点过信里的确认按钮）、待确认 <b>{counts.pending}</b>（信发到了但还没点，或压根没收到）、已退订
  <b>{counts.unsubscribed}</b>。只有「已确认」的会收到群发；确认时间在看下表格里那一列。
</p>

<div class="card table-wrap">
  <table class="cols-wide">
    <thead>
      <tr>
        <th>邮箱</th>
        <th>状态</th>
        <th>订阅时间</th>
        <th>确认时间</th>
        <th>退订时间</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each subs as s (s.id)}
        <tr>
          <td>{s.email}</td>
          <td><span class="badge {badgeCls(s.status)}">{zhStatus(s.status)}</span></td>
          <td class="small muted">{fmtDate(s.createdAt)}</td>
          <td class="small muted">{s.confirmedAt ? fmtDate(s.confirmedAt) : '—'}</td>
          <td class="small muted">{s.unsubscribedAt ? fmtDate(s.unsubscribedAt) : '—'}</td>
          <td>
            <div class="row ops">
              <button class="sm" onclick={() => void confirmSub(s)} disabled={busy === s.id || s.status === 'confirmed'}>审核通过</button>
              <button class="sm" onclick={() => void unsubscribe(s)} disabled={busy === s.id || s.status === 'unsubscribed'}>取订</button>
              <button class="sm danger" onclick={() => void remove(s)} disabled={busy === s.id}>删除</button>
            </div>
          </td>
        </tr>
      {:else}
        <tr><td colspan="6" class="muted">{loading ? '加载中…' : '该状态下暂无订阅者。'}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<h3>邮件日志</h3>
<div class="card table-wrap">
  <table class="cols-wide mail-log">
    <thead>
      <tr><th>收件人</th><th>主题</th><th>状态</th><th>时间</th><th>错误</th></tr>
    </thead>
    <tbody>
      {#each logs.slice(0, 50) as l (l.id)}
        <tr>
          <td class="small">{l.to}</td>
          <td class="small">{l.subject}</td>
          <td><span class="badge {l.status === 'sent' ? 'good' : l.status === 'failed' ? 'bad' : 'pending'}">{l.status}</span></td>
          <td class="small muted">{fmtDate(l.createdAt)}</td>
          <td class="small err">{l.error ?? ''}</td>
        </tr>
      {:else}
        <tr><td colspan="5" class="muted">还没有邮件记录。</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .head {
    margin-bottom: 0.6rem;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.7rem 0;
  }
  .small {
    font-size: 0.76rem;
  }
  .btn {
    display: inline-block;
    padding: 0.18rem 0.6rem;
    font-size: 0.82rem;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-fg);
  }
  table {
    table-layout: fixed;
  }
  td,
  th {
    overflow-wrap: anywhere;
  }
  .ops {
    justify-content: flex-end;
    white-space: nowrap;
  }
  .mail-log th:nth-child(1) { width: 210px; }
  .mail-log th:nth-child(3) { width: 76px; }
  .mail-log th:nth-child(4) { width: 150px; }
  .mail-log th:nth-child(5) { width: 220px; }
  .mail-log td:nth-child(1),
  .mail-log td:nth-child(3),
  .mail-log td:nth-child(4) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mail-log td:nth-child(2) {
    overflow-wrap: break-word;
  }
  .ops button + button {
    margin-left: 0.3rem;
  }
</style>
