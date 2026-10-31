<script lang="ts">
  import { flash } from '#lib/toast.svelte';
  import { del, get, patch, post } from '#lib/api';
  import { fmtDate, timeAgo } from '#lib/api';
  import { frontUrl } from '#lib/session.svelte';
  import { session } from '#lib/session.svelte';

  const PERM_LABEL = {
    canPublish: '投稿权限',
    canAuthor: '作者认证申请',
  } as const;

  type Perm = keyof typeof PERM_LABEL;
  const PERM_KEYS: Perm[] = ['canPublish', 'canAuthor'];

  /** 用户组：朋友（注册默认）/ 共创（作者认证通过后进入），后台可手动互切 */
  const GROUPS = [
    { value: 'friend', label: '朋友' },
    { value: 'coauthor', label: '共创' },
  ] as const;
  type UserGroup = (typeof GROUPS)[number]['value'];
  const GROUP_LABEL: Record<string, string> = { friend: '朋友', coauthor: '共创' };

  interface Row {
    id: string;
    email: string;
    name: string | null;
    handle: string | null;
    /** 用户中心地址用的账号标识 */
    accountSlug: string | null;
    /** 'friend' | 'coauthor' */
    userGroup: string | null;
    role: string;
    status: string;
    canPublish: boolean;
    canAuthor: boolean;
    authorVerified: boolean;
    emailVerified: boolean;
    invitedCode: string | null;
    createdAt: number;
    commentCount: number;
  }
  interface Cmt {
    id: string;
    postSlug: string;
    /** 接口从内容仓库 front matter 认出来的标题；认不到为空，界面回落到地址 */
    postTitle?: string;
    content: string;
    status: string;
    createdAt: number;
  }

  let tab = $state<'users' | 'invites' | 'deletions'>('users');

  let rows = $state<Row[]>([]);
  let total = $state(0);
  let q = $state('');
  let loading = $state(false);
  let error = $state('');
  let notice = $state('');
  /* 顶部那行结果提示改走右上角浮层（页面一长就看不见那行小字） */
  flash('err', () => error);
  flash('ok', () => notice);
  let busy = $state('');

  // 点「评论」时展开的那一行
  let detail = $state<{ id: string; items: Cmt[] } | null>(null);
  // 删除账号：必须手输邮箱二次确认
  let deleting = $state<{ id: string; email: string; typed: string } | null>(null);

  async function load() {
    loading = true;
    error = '';
    try {
      const d = await get<{ data: { total: number; data: Row[]; items?: Row[] } }>(
        `/api/admin/users${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      );
      rows = d.data.items ?? d.data.data;
      total = d.data.total;
    } catch (e) {
      error = e instanceof Error ? e.message : '读取失败';
    } finally {
      loading = false;
    }
  }

  async function setGroup(r: Row, group: UserGroup) {
    if ((r.userGroup ?? 'friend') === group) return;
    busy = r.id;
    error = '';
    notice = '';
    try {
      await patch(`/api/admin/users/${r.id}`, { user_group: group });
      r.userGroup = group;
      notice = `${r.email} 的用户组已改为「${GROUP_LABEL[group]}」`;
    } catch (e) {
      error = e instanceof Error ? e.message : '用户组修改失败（后端 PATCH /api/admin/users/:id 需支持 user_group）';
      await load();
    } finally {
      busy = '';
    }
  }

  async function togglePerm(r: Row, key: Perm, value: boolean) {
    busy = r.id;
    error = '';
    notice = '';
    try {
      await patch(`/api/admin/users/${r.id}`, { [key]: value });
      r[key] = value;
      notice = `${r.email} 的${PERM_LABEL[key]}已${value ? '开通' : '关闭'}`;
    } catch (e) {
      error = e instanceof Error ? e.message : '权限修改失败';
      await load();
    } finally {
      busy = '';
    }
  }

  /** 认证徽章：撤销要有确认，前台署名胜的标识会一并消失 */
  async function toggleVerified(r: Row, value: boolean) {
    if (!value && !confirm(`撤销 ${r.email} 的认证徽章？文章署名旁的标识会一并消失。`)) {
      await load();
      return;
    }
    busy = r.id;
    error = '';
    notice = '';
    try {
      await patch(`/api/admin/users/${r.id}`, { authorVerified: value });
      r.authorVerified = value;
      notice = value ? `${r.email} 已授予认证徽章` : `${r.email} 的认证徽章已撤销`;
    } catch (e) {
      error = e instanceof Error ? e.message : '认证状态修改失败';
      await load();
    } finally {
      busy = '';
    }
  }

  /** 作者标识决定前台 /author/<标识>/ 与认证徽章能不能对上文章的 author 署名 */
  async function saveHandle(r: Row, raw: string) {
    const value = raw.trim();
    if (value === (r.handle ?? '')) return;
    busy = r.id;
    error = '';
    notice = '';
    try {
      await patch(`/api/admin/users/${r.id}`, { handle: value || null });
      notice = value ? `${r.email} 的作者标识已设为 ${value}` : `${r.email} 的作者标识已清空`;
    } catch (e) {
      error = e instanceof Error ? e.message : '作者标识保存失败';
    } finally {
      busy = '';
      await load();
    }
  }

  async function toggleBan(r: Row) {
    const to = r.status === 'banned' ? 'active' : 'banned';
    if (to === 'banned' && !confirm(`封禁 ${r.email}？会立刻踢掉他的登录状态。`)) return;
    busy = r.id;
    error = '';
    try {
      await patch(`/api/admin/users/${r.id}`, { status: to });
      notice = `${r.email} 已${to === 'banned' ? '封禁' : '解封'}`;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '操作失败';
    } finally {
      busy = '';
    }
  }

  /**
   * 删除账号：不可恢复，输入完整邮箱才放行。
   * 后端要删掉该账号的会话、第三方身份、评论、投稿、认证申请与邀请消费记录。
   */
  async function removeUser() {
    const target = deleting;
    if (!target) return;
    if (target.typed.trim().toLowerCase() !== target.email.toLowerCase()) {
      error = '输入的邮箱与账号不一致，未执行删除';
      return;
    }
    busy = target.id;
    error = '';
    try {
      await del(`/api/admin/users/${target.id}`);
      notice = `${target.email} 及其关联数据已删除`;
      deleting = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : '删除失败（后端需实现 DELETE /api/admin/users/:id）';
    } finally {
      busy = '';
    }
  }

  async function openDetail(r: Row) {
    if (detail?.id === r.id) {
      detail = null;
      return;
    }
    busy = r.id;
    error = '';
    try {
      const d = await get<{ data: Cmt[] }>(`/api/admin/users/${r.id}/comments`);
      detail = { id: r.id, items: d.data };
    } catch (e) {
      error = e instanceof Error ? e.message : '评论读取失败';
    } finally {
      busy = '';
    }
  }

  /* ---------------- 重置密码：明文只活在这一次响应里 ---------------- */

  interface ResetTicket {
    id: string;
    email: string;
    password: string;
    sessionsKilled: number;
    message: string;
  }

  let reset = $state<ResetTicket | null>(null);
  let resetCopied = $state(false);

  /** 后端也会拒管理员与自己，但前端就别给可点的按钮 */
  function canReset(r: Row): boolean {
    return r.role !== 'admin' && r.id !== session.user?.id;
  }

  async function resetPassword(r: Row) {
    if (!canReset(r)) {
      error = '管理员自己的账号请用「我的信息」页改密码';
      return;
    }
    if (reset?.id === r.id) reset = null;
    if (!confirm(`重置 ${r.email} 的密码？\n\n会生成一个新随机密码并踢掉该账号所有登录会话（其它设备立刻掉线）。新密码只显示一次。`)) {
      return;
    }
    busy = r.id;
    error = '';
    notice = '';
    resetCopied = false;
    try {
      const d = await post<{ data: ResetTicket }>(`/api/admin/users/${r.id}/reset-password`);
      // 后端回的是它自己的那份 id/email，直接用它给的面板内容
      reset = d.data;
    } catch (e) {
      error = e instanceof Error ? e.message : '重置密码失败';
    } finally {
      busy = '';
    }
  }

  function closeReset() {
    // 密码只存这一个 state，关掉就清空：不写 localStorage、不再回读
    reset = null;
    resetCopied = false;
  }

  async function copyPassword() {
    if (!reset) return;
    try {
      await navigator.clipboard.writeText(reset.password);
      resetCopied = true;
      setTimeout(() => (resetCopied = false), 2000);
    } catch {
      error = '浏览器不允许直接复制，请手动选中密码';
    }
  }

  /* ---------------- 邀请码 tab（原 /invites 页搬进来） ---------------- */

  interface Invite {
    id: string;
    code: string;
    note: string | null;
    maxUses: number;
    usedCount: number;
    expiresAt: number | null;
    status: string;
    createdAt: number;
  }
  interface Usage {
    id: string;
    email: string;
    name: string | null;
    createdAt: number;
  }

  let invites = $state<Invite[]>([]);
  let invitesLoaded = $state(false);
  let activeInvites = $state(0);
  let invLoading = $state(false);
  let invError = $state('');
  let invNotice = $state('');
  let note = $state('');
  let uses = $state(1);
  let days = $state(0);
  let count = $state(1);
  let customCode = $state('');
  let creating = $state(false);
  let usage = $state<{ id: string; code: string; items: Usage[] } | null>(null);
  let copied = $state('');

  async function loadInvites() {
    invLoading = true;
    invError = '';
    try {
      const [list, sum] = await Promise.all([
        get<{ data: Invite[] }>('/api/admin/invites'),
        get<{ data: { active: number } }>('/api/admin/invites/summary'),
      ]);
      invites = list.data;
      activeInvites = sum.data.active;
      invitesLoaded = true;
    } catch (e) {
      invError = e instanceof Error ? e.message : '读取失败';
    } finally {
      invLoading = false;
    }
  }

  async function createInvite() {
    creating = true;
    invError = '';
    invNotice = '';
    try {
      const body: Record<string, number | string> = { uses, days, count };
      if (note.trim()) body.note = note.trim();
      if (count === 1 && customCode.trim()) body.code = customCode.trim().toUpperCase();
      const d = await post<{ data: Invite | Invite[] }>('/api/admin/invites', body);
      const created = Array.isArray(d.data) ? d.data : [d.data];
      invNotice = `已生成 ${created.length} 个：${created.map((c) => c.code).join('、')}`;
      customCode = '';
      await loadInvites();
    } catch (e) {
      invError = e instanceof Error ? e.message : '生成失败';
    } finally {
      creating = false;
    }
  }

  async function revokeInvite(r: Invite) {
    if (!confirm(`作废邀请码 ${r.code}？已注册的用户不受影响。`)) return;
    invError = '';
    try {
      await post(`/api/admin/invites/${r.id}/revoke`);
      await loadInvites();
    } catch (e) {
      invError = e instanceof Error ? e.message : '作废失败';
    }
  }

  async function openUsage(r: Invite) {
    if (usage?.id === r.id) {
      usage = null;
      return;
    }
    invError = '';
    try {
      const d = await get<{ data: Usage[] }>(`/api/admin/invites/${r.id}/usage`);
      usage = { id: r.id, code: r.code, items: d.data };
    } catch (e) {
      invError = e instanceof Error ? e.message : '读取使用情况失败';
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = text;
      setTimeout(() => (copied = ''), 2000);
    } catch {
      invError = '浏览器不允许直接复制，请手动选中';
    }
  }

  function stateOf(r: Invite): { label: string; cls: string } {
    if (r.status !== 'active') return { label: '已作废', cls: 'bad' };
    if (r.expiresAt && r.expiresAt * 1000 < Date.now()) return { label: '已过期', cls: 'pending' };
    if (r.maxUses > 0 && r.usedCount >= r.maxUses) return { label: '已用完', cls: 'pending' };
    return { label: '可用', cls: 'good' };
  }

  /* ---------------- 注销审核 tab ---------------- */

  interface Deletion {
    id: string;
    userId: string;
    reason: string | null;
    status: string;
    reviewNote: string | null;
    reviewerId: string | null;
    createdAt: number;
    reviewedAt: number | null;
    accountName: string | null;
    accountEmail: string | null;
    accountSlug: string | null;
    accountHandle: string | null;
    accountRole: string | null;
    accountStatus: string | null;
    centerUrl: string;
    /** 账号行已经不在了，后端据此让按钮失效 */
    missing: boolean;
    /** 通过后会删掉的东西（后端现算；账号已不在或队列太长时可能没有这一项） */
    willDelete?: Record<string, number>;
    totalToDelete?: number;
  }

  const DEL_FILTERS = [
    { value: 'pending', label: '待处理' },
    { value: 'approved', label: '已通过' },
    { value: 'rejected', label: '已驳回' },
    { value: 'all', label: '全部' },
  ] as const;
  type DelFilter = (typeof DEL_FILTERS)[number]['value'];

  const DEL_STATUS_LABEL: Record<string, string> = { pending: '待处理', approved: '已通过', rejected: '已驳回' };

  /** purgeUser 返回的是表名键，界面翻成人能看懂的（没收录的键原样显示） */
  const PURGE_LABEL: Record<string, string> = {
    comments: '评论',
    commentLikes: '评论点赞',
    reactions: '点赞收藏',
    postDrafts: '投稿',
    authorRequests: '认证申请',
    friendApplications: '友链申请',
    sessions: '登录会话',
    accounts: '第三方身份',
    subscribers: '邮件订阅',
    verifications: '验证码记录',
    commenters: '游客身份',
    auditLogsAnonymized: '审计留痕',
    users: '账号',
  };

  let deletions = $state<Deletion[]>([]);
  let deletionsLoaded = $state(false);
  let delFilter = $state<DelFilter>('pending');
  let delLoading = $state(false);
  let delBusy = $state('');
  let delError = $state('');
  let delNotice = $state('');
  let pendingDeletions = $state(0);
  /** 驳回用的可选备注，会原样回给用户看 */
  let rejecting = $state<{ id: string; who: string; note: string } | null>(null);

  function whoOf(r: Deletion): string {
    return r.accountEmail || (r.accountSlug ? `@${r.accountSlug}` : '（账号已不存在）');
  }

  async function loadDeletions() {
    delLoading = true;
    delError = '';
    try {
      const d = await get<{
        data: { status: string; total: number; items: Deletion[]; byStatus: Record<string, number> };
      }>(`/api/admin/deletions?status=${delFilter}`);
      deletions = d.data.items;
      pendingDeletions = d.data.byStatus.pending ?? 0;
      deletionsLoaded = true;
    } catch (e) {
      delError = e instanceof Error ? e.message : '注销申请读取失败（后端 GET /api/admin/deletions）';
      deletions = [];
    } finally {
      delLoading = false;
    }
  }

  /** 通过 = 级联删干净，不可撤销，所以必须确认到位 */
  async function approveDeletion(r: Deletion) {
    const who = whoOf(r);
    /* 计数由后端在待办列表里现算（见 /api/admin/deletions 的 willDelete）：
       不可逆操作要看得见后果，光一句「全部数据」没人知道自己实际按下删了多少条。 */
    const will = Object.entries(r.willDelete ?? {})
      .filter(([, n]) => Number(n) > 0)
      .map(([k, n]) => `${PURGE_LABEL[k] ?? k} ${n}`)
      .join('、');
    if (
      !confirm(
        `通过 ${who} 的注销申请？\n\n通过后会立刻删除该账号的全部数据：登录会话、评论、点赞收藏、投稿、作者认证申请、友链申请与邀请码消费记录，账号本身一并移除，不可撤销、无法找回。${
          will ? `\n\n这条账号现有：${will}（合计 ${r.totalToDelete ?? 0} 项记录）。` : ''
        }\n\n确认执行请点「确定」。`,
      )
    ) {
      return;
    }
    delBusy = r.id;
    delError = '';
    delNotice = '';
    try {
      const d = await post<{ data: { message?: string; deleted?: Record<string, number> } }>(
        `/api/admin/deletions/${r.id}/approve`,
      );
      const counts = Object.entries(d.data.deleted ?? {})
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${PURGE_LABEL[k] ?? k} ${n}`)
        .join('、');
      delNotice = d.data.message || '账号与其全部数据已删除';
      if (counts) delNotice += `（已清除：${counts}）`;
      rejecting = null;
      await loadDeletions();
    } catch (e) {
      delError = e instanceof Error ? e.message : '通过失败';
      await loadDeletions();
    } finally {
      delBusy = '';
    }
  }

  async function rejectDeletion(r: Deletion) {
    const note = rejecting?.note.trim() ?? '';
    delBusy = r.id;
    delError = '';
    delNotice = '';
    try {
      const d = await post<{ data: { message?: string } }>(`/api/admin/deletions/${r.id}/reject`, {
        note: note || undefined,
      });
      delNotice = `${d.data.message || '已驳回'}${note ? `（备注已随结果发给用户：${note}）` : ''}`;
      rejecting = null;
      await loadDeletions();
    } catch (e) {
      delError = e instanceof Error ? e.message : '驳回失败';
      await loadDeletions();
    } finally {
      delBusy = '';
    }
  }

  function startReject(r: Deletion) {
    rejecting = rejecting?.id === r.id ? null : { id: r.id, who: whoOf(r), note: '' };
  }

  /** 空列表与「还没读」要分得开，否则看着像没数据 */
  const delEmptyText = $derived(
    delLoading
      ? '正在读取注销申请…'
      : !deletionsLoaded
        ? '还没读到注销申请，点右上角「重新读取」；读失败的原因见上方红字。'
        : delFilter === 'all'
          ? '还没有任何人提交过注销申请。'
          : `没有「${DEL_FILTERS.find((f) => f.value === delFilter)?.label ?? delFilter}」的注销申请。`,
  );

  $effect(() => {
    void load();
  });

  $effect(() => {
    // 只在第一次切到邀请码 tab 时读；用显式标记而不是「列表为空」，免得一条没有时反复请求
    if (tab === 'invites' && !invitesLoaded && !invLoading) void loadInvites();
  });

  $effect(() => {
    if (tab === 'deletions' && !deletionsLoaded && !delLoading) void loadDeletions();
  });
</script>

<div class="row spread head">
  <h2>用户与邀请码</h2>
  {#if tab === 'users'}
    <div class="row searchbar">
      <input class="search" placeholder="按邮箱 / 昵称 / 作者标识 / 邀请码筛选" bind:value={q} onkeydown={(e) => e.key === 'Enter' && load()} />
      <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '查询中…' : '查询'}</button>
    </div>
  {:else if tab === 'invites'}
    <button class="sm" onclick={() => void loadInvites()} disabled={invLoading}>{invLoading ? '读取中…' : '重新读取'}</button>
  {:else}
    <div class="row">
      <select
        class="grp"
        value={delFilter}
        aria-label="注销申请状态筛选"
        onchange={(e) => {
          delFilter = e.currentTarget.value as DelFilter;
          void loadDeletions();
        }}
      >
        {#each DEL_FILTERS as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
      </select>
      <button class="sm" onclick={() => void loadDeletions()} disabled={delLoading}>{delLoading ? '读取中…' : '重新读取'}</button>
    </div>
  {/if}
</div>

<div class="tabs">
  <button class="tab" class:on={tab === 'users'} onclick={() => (tab = 'users')}>用户 <span class="n">{total}</span></button>
  <button class="tab" class:on={tab === 'invites'} onclick={() => (tab = 'invites')}>
    邀请码 <span class="n">{activeInvites}</span>
  </button>
  <button class="tab" class:on={tab === 'deletions'} onclick={() => (tab = 'deletions')}>
    注销审核 <span class="n">{pendingDeletions}</span>
  </button>
</div>

{#if tab === 'users'}
  <p class="muted small">共 {total} 位。</p>

  {#if reset}
    <section class="card once">
      <h3>新密码（只显示这一次）</h3>
      <div class="row spread">
        <code class="pw" title="双击选中后可复制">{reset.password}</code>
        <div class="row">
          <button class="sm" onclick={() => void copyPassword()}>{resetCopied ? '已复制' : '复制密码'}</button>
          <button class="sm ghost" onclick={closeReset}>我已记下，关闭</button>
        </div>
      </div>
      <p class="muted small">
        账号：{reset.email}｜被注销的登录会话：{reset.sessionsKilled} 个｜关闭面板后无法再查看，只能重新重置一次
      </p>
      <p class="err small">{reset.message}</p>
    </section>
  {/if}

  <div class="ulist">
    {#each rows as r (r.id)}
      {@const expanded = detail?.id === r.id}
      <div class="ucard">
        <div class="umain">
          <div class="uwho">
            <div class="uname">
              <span class="nick" title={r.name || ''}>{r.name || '（未命名）'}</span>
              {#if r.accountSlug && frontUrl(`/account/me/?u=@${r.accountSlug}`)}
                <a
                  class="tag"
                  href={frontUrl(`/account/me/?u=@${r.accountSlug}`)}
                  target="_blank"
                  rel="noreferrer"
                  title={`在前台打开 @${r.accountSlug} 的个人中心`}
                >@{r.accountSlug}</a>
              {:else}
                <span class="tag" title={`账号标识 @${r.accountSlug ?? ''}`}>@{r.accountSlug || '—'}</span>
              {/if}
            </div>
            <div class="uemail" title={r.email}>{r.email}</div>
          </div>

          <div class="ufields">
            <span class="fld">
              <span class="k">用户组</span>
              {#if r.role === 'admin'}
                <span class="badge">站长</span>
              {:else}
                <select
                  class="grp"
                  value={r.userGroup ?? 'friend'}
                  disabled={busy === r.id}
                  aria-label="用户组"
                  onchange={(e) => setGroup(r, e.currentTarget.value as UserGroup)}
                >
                  {#each GROUPS as g (g.value)}<option value={g.value}>{g.label}</option>{/each}
                </select>
              {/if}
            </span>
            <span class="fld">
              <span class="k">状态</span>
              <span class="badge {r.status === 'banned' ? 'bad' : 'good'}">{r.status === 'banned' ? '封禁' : '正常'}</span>
            </span>
            <span class="fld">
              <span class="k">权限</span>
              <span class="mini {r.canPublish ? 'on' : ''}" title="投稿权限">投稿</span>
              <span class="mini {r.canAuthor ? 'on' : ''}" title="作者认证申请">认证申请</span>
              <span class="mini {r.authorVerified ? 'on' : ''}" title="已认证">已认证</span>
            </span>
            <span class="fld"><span class="k">评论</span><span class="v">{r.commentCount}</span></span>
            <span class="fld"><span class="k">加入</span><span class="v" title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</span></span>
          </div>

          <div class="uops">
            <button class="sm ghost" onclick={() => void openDetail(r)} disabled={busy === r.id}>{expanded ? '收起' : '展开'}</button>
            <button
              class="sm"
              onclick={() => void resetPassword(r)}
              disabled={busy === r.id || !canReset(r)}
              title={canReset(r) ? '生成新密码并踢掉该账号全部会话' : '管理员自己的账号请用「我的信息」页改密码'}
            >
              重置密码
            </button>
            <button class="sm {r.status === 'banned' ? '' : 'danger'}" onclick={() => void toggleBan(r)} disabled={busy === r.id || r.role === 'admin'}
              title={r.role === 'admin' ? '站长账号不可封禁' : ''}>
              {r.status === 'banned' ? '解封' : '封禁'}
            </button>
            <button class="sm danger" onclick={() => (deleting = { id: r.id, email: r.email, typed: '' })} disabled={busy === r.id || r.role === 'admin'}
              title={r.role === 'admin' ? '站长账号不可删除' : ''}>
              删除账号
            </button>
          </div>
        </div>

        {#if expanded && detail}
          <div class="uext">
            <div class="extrow">
              <label class="handlefld">
                作者标识
                <input
                  class="handle"
                  value={r.handle ?? ''}
                  placeholder="未设置"
                  maxlength="40"
                  disabled={busy === r.id || r.role === 'admin'}
                  title={r.role === 'admin' ? '站长作者标识请到「我的信息」修改' : '小写字母、数字、短横线；要与文章 front matter 的 author 一致'}
                  onblur={(e) => void saveHandle(r, e.currentTarget.value)}
                  onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
              </label>
              <span class="badge {r.emailVerified ? 'good' : 'pending'}">{r.emailVerified ? '邮箱已验证' : '邮箱未验证'}</span>
              <span class="muted small">邀请码：{r.invitedCode || '—'}</span>
            </div>
            <div class="extrow">
              {#each PERM_KEYS as key (key)}
                <label class="perm">
                  <input
                    type="checkbox"
                    checked={r[key]}
                    disabled={busy === r.id || r.role === 'admin'}
                    onchange={(e) => togglePerm(r, key, e.currentTarget.checked)}
                  />
                  <span>{PERM_LABEL[key]}</span>
                </label>
              {/each}
              <label class="perm">
                <input
                  type="checkbox"
                  checked={r.authorVerified}
                  disabled={busy === r.id || r.role === 'admin'}
                  onchange={(e) => void toggleVerified(r, e.currentTarget.checked)}
                />
                <span>已认证徽章</span>
              </label>
            </div>
            <div class="extrow comments">
              <span class="k">最近评论</span>
              {#if detail.items.length === 0}
                <span class="muted small">还没有写过评论。</span>
              {:else}
                {#each detail.items as c (c.id)}
                  <div class="line">
                    <span class="badge {c.status === 'approved' ? 'good' : c.status === 'spam' ? 'bad' : 'pending'}">{c.status}</span>
                    {#if frontUrl(c.postSlug)}
                      <a class="cmt-url" href={frontUrl(c.postSlug)} target="_blank" rel="noreferrer" title={c.postSlug}>{c.postTitle || c.postSlug}</a>
                    {:else}
                      <span class="cmt-url muted" title="后台「设置 → 站点信息」里的站点地址为空，暂时给不出前台链接">{c.postTitle || c.postSlug}</span>
                    {/if}
                    <span class="cmt-body">{c.content.slice(0, 120)}</span>
                    <span class="muted small">{timeAgo(c.createdAt)}</span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/if}

        {#if deleting?.id === r.id}
          <div class="delbox">
            <p class="err">
              删除 {deleting.email} 会一并清除其会话、第三方身份、评论、投稿、认证申请与邀请码消费记录，且不可恢复。
            </p>
            <div class="row">
              <input placeholder="输入完整邮箱以确认" bind:value={deleting.typed} />
              <button class="sm danger" onclick={() => void removeUser()} disabled={deleting.typed.trim().toLowerCase() !== r.email.toLowerCase()}>
                确认删除
              </button>
              <button class="sm ghost" onclick={() => (deleting = null)}>取消</button>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <p class="muted card">{loading ? '加载中…' : '没有匹配的用户'}</p>
    {/each}
  </div>
{:else if tab === 'invites'}
  <p class="muted small">
    生效中 {activeInvites} 个 / 共 {invites.length} 个。只有在「设置 - 注册与邀请码」里打开「注册需邀请码」时才会校验；
    关闭开关后所有人可凭邮箱注册。
  </p>
  {#if invError}<p class="err">{invError}</p>{/if}
  {#if invNotice}<p class="ok">{invNotice}</p>{/if}
  {#if copied}<p class="ok small">已复制 {copied}</p>{/if}

  <section class="card form">
    <h3>生成</h3>
    <div class="grid">
      <label>
        备注
        <input placeholder="例如：送给读者群" bind:value={note} maxlength="200" />
      </label>
      <label>
        可用次数
        <input type="number" min="0" max="100000" bind:value={uses} />
        <span class="muted hint">0 表示不限次数</span>
      </label>
      <label>
        有效天数
        <input type="number" min="0" max="3650" bind:value={days} />
        <span class="muted hint">0 表示永久</span>
      </label>
      <label>
        生成个数
        <input type="number" min="1" max="50" bind:value={count} />
        <span class="muted hint">批量时不能自定义码</span>
      </label>
      <label>
        自定义码（单个时）
        <input placeholder="留空则随机" bind:value={customCode} maxlength="64" disabled={count > 1} />
        <span class="muted hint">大写字母与 2-9（不含 0 和 1），长度 4-32</span>
      </label>
    </div>
    <div class="row actions">
      <button class="primary" onclick={() => void createInvite()} disabled={creating}>
        {creating ? '生成中…' : `生成 ${count} 个`}
      </button>
    </div>
  </section>

  <div class="card">
    <div class="table-wrap">
      <table class="cols-wide">
        <thead>
          <tr>
            <th>码</th>
            <th>备注</th>
            <th>状态</th>
            <th>已用 / 上限</th>
            <th>到期</th>
            <th>创建于</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each invites as r (r.id)}
            {@const s = stateOf(r)}
            <tr>
              <td><code class="code">{r.code}</code></td>
              <td>{r.note || '—'}</td>
              <td><span class="badge {s.cls}">{s.label}</span></td>
              <td>{r.usedCount} / {r.maxUses || '不限'}</td>
              <td>{r.expiresAt ? fmtDate(r.expiresAt) : '永久'}</td>
              <td title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
              <td class="ops">
                <button class="sm" onclick={() => void copy(r.code)}>复制</button>
                <button class="sm" onclick={() => openUsage(r)}>{usage?.id === r.id ? '收起' : '用了谁'}</button>
                {#if r.status === 'active'}
                  <button class="sm danger" onclick={() => void revokeInvite(r)}>作废</button>
                {/if}
              </td>
            </tr>
            {#if usage?.id === r.id}
              <tr class="detail">
                <td colspan="7">
                  {#if usage.items.length === 0}
                    <span class="muted small">还没有人用这个码注册。</span>
                  {:else}
                    {#each usage.items as u (u.id)}
                      <div class="line">
                        <span>{u.email}</span>
                        <span class="muted small">{u.name || ''}</span>
                        <span class="muted small">{timeAgo(u.createdAt)}</span>
                      </div>
                    {/each}
                  {/if}
                </td>
              </tr>
            {/if}
          {:else}
            <tr><td colspan="7" class="muted">{invLoading ? '加载中…' : '还没有邀请码'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{:else}
  <p class="muted small">
    用户在个人中心提交的注销申请。「通过注销」= 立刻级联删除该账号的全部数据（会话、评论、投稿、认证申请、友链申请、邀请码消费记录）
    并移除账号，<em>不可撤销</em>；「驳回」只把申请标为已驳回，账号保持不变，备注会显示给用户。
  </p>
  {#if delError}<p class="err">{delError}</p>{/if}
  {#if delNotice}<p class="ok">{delNotice}</p>{/if}

  <div class="card">
    <div class="table-wrap">
      <table class="cols-wide">
        <thead>
          <tr>
            <th>账号</th>
            <th>注销理由</th>
            <th>状态</th>
            <th>申请时间</th>
            <th>处理时间 / 备注</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each deletions as r (r.id)}
            <tr>
              <td>
                <div class="acct">
                  <span class="nick" title={r.accountName || ''}>{r.accountName || '（未命名）'}</span>
                  {#if frontUrl(r.centerUrl)}
                    <a class="tag" href={frontUrl(r.centerUrl)} target="_blank" rel="noreferrer" title="在前台打开这个账号的个人中心">
                      @{r.accountSlug || '—'}
                    </a>
                  {:else}
                    <span class="tag" title={`账号标识 @${r.accountSlug ?? ''}`}>@{r.accountSlug || '—'}</span>
                  {/if}
                </div>
                <div class="uemail" title={r.accountEmail ?? ''}>{r.accountEmail || '（账号已不存在）'}</div>
                {#if r.accountRole === 'admin'}<span class="badge pending">站长账号</span>{/if}
                {#if r.accountStatus === 'banned'}<span class="badge bad">已封禁</span>{/if}
              </td>
              <td class="reason">{r.reason || '（没有填写理由）'}</td>
              <td>
                <span class="badge {r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'pending'}">
                  {DEL_STATUS_LABEL[r.status] ?? r.status}
                </span>
              </td>
              <td title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
              <td>
                {r.reviewedAt ? fmtDate(r.reviewedAt) : '—'}
                {#if r.reviewNote}<div class="muted small">备注：{r.reviewNote}</div>{/if}
              </td>
              <td class="ops">
                {#if r.missing}
                  <span class="muted small">账号已不在，无需处理</span>
                {:else if r.status === 'pending'}
                  <button class="sm danger" onclick={() => void approveDeletion(r)} disabled={delBusy === r.id}>
                    {delBusy === r.id ? '处理中…' : '通过注销'}
                  </button>
                  <button class="sm" onclick={() => startReject(r)} disabled={delBusy === r.id}>
                    {rejecting?.id === r.id ? '收起' : '驳回'}
                  </button>
                {:else}
                  <span class="muted small">已处理，不可重复操作</span>
                {/if}
              </td>
            </tr>
            {#if rejecting?.id === r.id}
              <tr class="detail">
                <td colspan="6">
                  <div class="row">
                    <input placeholder="驳回说明（选填，用户能在个人中心看到）" maxlength="500" bind:value={rejecting.note} />
                    <button class="sm" onclick={() => void rejectDeletion(r)} disabled={delBusy === r.id}>确认驳回</button>
                    <button class="sm ghost" onclick={() => (rejecting = null)}>取消</button>
                  </div>
                  <p class="muted small">驳回后 {rejecting.who} 的账号与数据保持不变，仅这条申请标记为已驳回。</p>
                </td>
              </tr>
            {/if}
          {:else}
            <tr>
              <td colspan="6" class="muted">
                {delEmptyText}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<style>
  .head {
    margin-bottom: 0.5rem;
  }
  .tabs {
    display: flex;
    gap: 0.35rem;
    margin-bottom: 0.8rem;
  }
  .tab {
    padding: 0.25rem 0.9rem;
    font-size: 0.86rem;
    border-radius: 999px;
  }
  .tab.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .tab .n {
    font-style: normal;
    margin-left: 0.3rem;
    opacity: 0.75;
    font-size: 0.76rem;
  }
  /* 选中那一档底色是主色，再乘 0.75 透明度就把对比度压到 4.26 了 */
  .tab.on .n {
    opacity: 1;
  }
  .searchbar {
    flex-wrap: nowrap;
  }
  .search {
    width: min(240px, 100%);
    flex: 1 1 240px;
    min-width: 0;
  }
  .searchbar button {
    flex: none;
  }
  .small {
    font-size: 0.76rem;
  }
  .ops {
    white-space: nowrap;
  }
  /* ---------------- 用户卡片列表 ---------------- */
  .ulist {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .ucard {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.7rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .umain {
    display: grid;
    grid-template-columns: minmax(150px, 1.1fr) minmax(0, 2.2fr) auto;
    gap: 0.8rem 1rem;
    align-items: center;
  }
  .uwho {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .uname {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }
  .nick {
    font-weight: 650;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.78rem;
    color: var(--muted);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .uemail {
    font-size: 0.78rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ufields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.9rem;
    align-items: center;
    min-width: 0;
  }
  .fld {
    display: flex;
    align-items: center;
    gap: 0.32rem;
    font-size: 0.82rem;
  }
  .fld .k {
    color: var(--muted);
    font-size: 0.74rem;
  }
  .fld .v {
    color: var(--fg);
  }
  .grp {
    padding: 0.12rem 0.4rem;
    font-size: 0.8rem;
  }
  .mini {
    font-size: 0.72rem;
    border-radius: 999px;
    padding: 0.04rem 0.42rem;
    background: var(--panel-2);
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .mini.on {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: transparent;
  }
  .uops {
    display: flex;
    gap: 0.35rem;
    justify-content: flex-end;
    white-space: nowrap;
  }
  .uext {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem;
    background: var(--panel-2);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .extrow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
  }
  .extrow .k {
    color: var(--muted);
    font-size: 0.76rem;
  }
  .handlefld {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .comments {
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
  }
  .cmt-url {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cmt-body {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delbox {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.7rem;
    background: var(--bad-soft);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
  }
  .delbox input {
    width: min(260px, 100%);
  }
  @media (max-width: 820px) {
    .umain {
      grid-template-columns: 1fr;
    }
    .uops {
      justify-content: flex-start;
    }
  }
  .handle {
    width: 120px;
    padding: 0.16rem 0.35rem;
    font-size: 0.8rem;
  }
  .perm {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.76rem;
    line-height: 1.5;
    cursor: pointer;
  }
  .perm input {
    width: 14px;
    height: 14px;
    margin: 0;
  }
  .ops button + button {
    margin-left: 0.35rem;
  }
  .detail td {
    background: var(--panel-2);
  }
  .line {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.22rem 0;
    font-size: 0.84rem;
  }
  select {
    padding: 0.2rem 0.4rem;
    font-size: 0.82rem;
  }
  .form {
    margin: 0 0 1rem;
  }
  .form h3 {
    margin: 0 0 0.6rem;
    font-size: 0.95rem;
  }
  .grid {
    display: grid;
    grid-template-columns: var(--t-5);
    gap: 0.7rem;
  }
  .hint {
    font-size: 0.72rem;
  }
  .actions {
    margin-top: 0.8rem;
  }
  .code {
    font-family: ui-monospace, Consolas, monospace;
    background: var(--panel-2);
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    letter-spacing: 0.06em;
  }
  /* ---------------- 一次性新密码面板：只显示一次，故意做得显眼 ---------------- */
  .once {
    margin-bottom: 0.9rem;
    border-color: var(--warn-border);
    background: var(--warn-soft);
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .once h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .pw {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 1.12rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    background: var(--panel);
    border: 1px dashed #f59e0b;
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    /* 没权限用剪贴板时至少能一键全选手抄 */
    user-select: all;
  }
  /* ---------------- 注销审核 ---------------- */
  .acct {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
  }
  .reason {
    max-width: 240px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
