<script lang="ts">
  import { del, fmtDate, get, healthWarn, mailNote, patch, post, timeAgo, type BuildHealth } from '#lib/api';
  import { assetUrl } from '#lib/session.svelte';

  type Kind = 'friend' | 'alliance';
  const KIND_LABEL: Record<Kind, string> = { friend: '友链', alliance: '站点联盟' };
  const KIND_ORDER: Kind[] = ['friend', 'alliance'];

  interface Friend {
    id: string;
    name: string;
    url: string;
    description: string | null;
    avatar: string | null;
    rssUrl: string | null;
    /** 'friend' | 'alliance'，缺省按友链处理 */
    kind: Kind;
    /** 同组内排序，数字小的在前 */
    sortOrder: number;
    status: 'active' | 'cooldown' | 'dead';
    failCount: number;
    lastCheckedAt: number | null;
    cooldownUntil: number | null;
    createdAt: number;
  }

  interface AppRow {
    id: string;
    name: string;
    url: string;
    description: string | null;
    avatar: string | null;
    rssUrl: string | null;
    email: string | null;
    reason: string | null;
    status: string;
    reviewerId: string | null;
    reviewNote: string | null;
    ip: string | null;
    createdAt: number;
    reviewedAt: number | null;
    publishedFriendId: string | null;
  }

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  const normKind = (f: Friend): Kind => (f.kind === 'alliance' ? 'alliance' : 'friend');

  let tab = $state<'list' | 'apps'>('list');

  /* ---------------- 友链列表 ---------------- */

  let list = $state<Friend[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let checking = $state(false);
  let checkResult = $state<string[]>([]);

  let showForm = $state(false);
  let editId = $state<string | null>(null);
  let name = $state('');
  let url = $state('');
  let description = $state('');
  let avatar = $state('');
  let rssUrl = $state('');
  let fkind = $state<Kind>('friend');

  async function loadFriends() {
    loading = true;
    error = '';
    try {
      const d = await get<{ data: Friend[] }>('/api/friends/all');
      list = d.data || [];
    } catch (e) {
      error = msg(e);
    } finally {
      loading = false;
    }
  }

  function reset() {
    editId = null;
    name = '';
    url = '';
    description = '';
    avatar = '';
    rssUrl = '';
    fkind = 'friend';
    showForm = true;
  }

  function startEdit(f: Friend) {
    editId = f.id;
    name = f.name;
    url = f.url;
    description = f.description ?? '';
    avatar = f.avatar ?? '';
    rssUrl = f.rssUrl ?? '';
    fkind = normKind(f);
    showForm = true;
  }

  /** 新增走 POST /api/admin/friends，编辑走 PATCH /api/admin/friends/:id（可改 kind） */
  async function save() {
    if (!name.trim() || !/^https?:\/\//i.test(url.trim())) {
      error = '名称必填，地址需以 http(s):// 开头';
      return;
    }
    busy = true;
    error = '';
    const body = {
      name: name.trim(),
      url: url.trim(),
      description: description.trim(),
      avatar: avatar.trim(),
      rssUrl: rssUrl.trim(),
      kind: fkind,
    };
    try {
      const d = editId
        ? await patch<{ data: FileBacked }>(`/api/admin/friends/${editId}`, body)
        : await post<{ data: FileBacked }>('/api/admin/friends', body);
      showForm = false;
      reset();
      await loadFriends();
      reportFile(d.data, editId ? '已更新' : '已添加');
    } catch (e) {
      error = msg(e);
    } finally {
      busy = false;
    }
  }

  async function remove(f: Friend) {
    if (!confirm(`删除友链「${f.name}」及其聚合文章？\n站点数据文件 data/links.yaml 里那一条也会一起删掉。`)) return;
    error = '';
    try {
      const d = await del<{ data: FileBacked }>(`/api/friends/${f.id}`);
      await loadFriends();
      reportFile(d.data, `已删除「${f.name}」`);
    } catch (e) {
      error = msg(e);
    }
  }

  /** 在两组之间移动：PATCH kind */
  async function moveKind(f: Friend) {
    const to: Kind = normKind(f) === 'alliance' ? 'friend' : 'alliance';
    error = '';
    try {
      const d = await patch<{ data: FileBacked }>(`/api/admin/friends/${f.id}`, { kind: to });
      await loadFriends();
      reportFile(d.data, `已把「${f.name}」移到「${KIND_LABEL[to]}」`);
    } catch (e) {
      error = msg(e);
    }
  }

  /* ---------------------------------------------------------------- 数据文件写回 */

  /** 后台每次改动都会同步 data/links.yaml，接口把那一步的结果放在 linksFile 里带回来 */
  interface FileBacked {
    linksFile?: {
      synced: boolean;
      reason?: 'unchanged' | 'not-found' | 'no-repo' | 'failed';
      error: string | null;
      buildHealth?: BuildHealth | null;
    };
  }

  /**
   * 前台「左邻右舍 / 站点联盟」是构建期读那份 yaml 的：
   * 库里改了而文件没改，页面上就还是老样子，所以这一步成不成必须让管理员看见。
   * 而且**写进去了还不算**：那份 yaml 一旦写坏（实测过段头 `friends: []` 后面挂条目那种），
   * Hugo 是整站构建失败、Pages 不换部署，所以 buildHealth 红的时候必须在这里点名 ——
   * 判据与提示都用 lib/api.ts 那一份 healthWarn，别在这一页再手抄一句。
   *
   * `synced:false` 有两种是**正常**的（本来就是这个样子 / 文件里没这一条），
   * 以前一律报成「站点数据文件没改」，看着像改动丢了；现在按 reason 分开说。
   */
  function reportFile(res: FileBacked | null | undefined, verb: string) {
    const f = res?.linksFile;
    const benign = f?.reason === 'unchanged' || f?.reason === 'not-found';
    notice = f?.synced
      ? `${verb}，已同步站点数据文件（等下一次构建刷新页面）`
      : benign
        ? `${verb}，数据文件本来就是这个样子（${f?.error ?? '无需改动'}）`
        : `${verb}（只改了数据库）`;
    if (f && !f.synced && !benign) error = `站点数据文件没改：${f.error ?? '未知原因'}`;
    const warn = f ? healthWarn(f.buildHealth) : '';
    if (warn) notice = `${notice} ${warn}`;
    setTimeout(() => (notice = ''), 8000);
  }

  async function checkNowPost() {
    checking = true;
    error = '';
    checkResult = [];
    try {
      /* 回执里现在带 pages:build（这一轮构建成没成）与中文名 label —— 以前只显示英文任务名，构建那条还被滤掉 */
      const d = await post<{ data: { name: string; label?: string; ok: boolean; detail: string }[] }>('/api/friends/check');
      checkResult = (d.data || []).map((o) => `${o.ok ? '✓' : '✕'} ${o.label || o.name}：${o.detail}`);
      await loadFriends();
    } catch (e) {
      error = msg(e);
    } finally {
      checking = false;
    }
  }

  const statusText = (f: Friend) => (f.status === 'active' ? '正常' : f.status === 'cooldown' ? '冷却中' : '已失效');

  /* ---------------- 排序模式：本地调序，保存时一次性 POST reorder ---------------- */

  let sortMode = $state(false);
  let savingOrder = $state(false);
  let draft = $state<Record<Kind, Friend[]>>({ friend: [], alliance: [] });

  function baseGroups(): Record<Kind, Friend[]> {
    const byOrder = (a: Friend, b: Friend) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt;
    return {
      friend: list.filter((f) => normKind(f) === 'friend').sort(byOrder),
      alliance: list.filter((f) => normKind(f) === 'alliance').sort(byOrder),
    };
  }

  const viewGroups = $derived(sortMode ? draft : baseGroups());

  function enterSort() {
    draft = baseGroups();
    sortMode = true;
    error = '';
  }

  function cancelSort() {
    sortMode = false;
  }

  function moveWithin(kind: Kind, idx: number, dir: -1 | 1) {
    const arr = [...draft[kind]];
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    draft = { ...draft, [kind]: arr };
  }

  async function saveOrder() {
    savingOrder = true;
    error = '';
    const items: { id: string; kind: Kind; sortOrder: number }[] = [];
    for (const kind of KIND_ORDER) draft[kind].forEach((f, i) => items.push({ id: f.id, kind, sortOrder: i }));
    try {
      await post('/api/admin/friends/reorder', { items });
      notice = '顺序已保存';
      sortMode = false;
      await loadFriends();
      setTimeout(() => (notice = ''), 2500);
    } catch (e) {
      error = msg(e);
    } finally {
      savingOrder = false;
    }
  }

  /* ---------------- 待审申请 ---------------- */

  const APP_TABS: [string, string][] = [
    ['pending', '待审'],
    ['approved', '已通过'],
    ['rejected', '已驳回'],
    ['all', '全部'],
  ];

  let appTab = $state('pending');
  let appQ = $state('');
  let apps = $state<AppRow[]>([]);
  let appTotal = $state(0);
  let appStats = $state<Record<string, number>>({ pending: 0, approved: 0, rejected: 0, total: 0 });
  let appsLoading = $state(false);
  let appsBusy = $state('');
  let appError = $state('');
  let appNotice = $state('');

  /** 展开审核的那一条 */
  let openId = $state<string | null>(null);
  let form = $state({ name: '', url: '', description: '', avatar: '', rssUrl: '', note: '' });
  let appKind = $state<Kind>('friend');
  let rejectNote = $state('');

  async function loadAppStats() {
    try {
      const s = await get<{ data: Record<string, number> }>('/api/admin/applications/stats');
      appStats = s.data;
    } catch {
      /* 角标读不到不影响主流程 */
    }
  }

  async function loadApps() {
    appsLoading = true;
    appError = '';
    try {
      const params = new URLSearchParams();
      if (appTab !== 'all') params.set('status', appTab);
      if (appQ.trim()) params.set('q', appQ.trim());
      const [l, s] = await Promise.all([
        get<{ data: { items: AppRow[]; total: number } }>(`/api/admin/applications?${params}`),
        get<{ data: Record<string, number> }>('/api/admin/applications/stats'),
      ]);
      apps = l.data.items;
      appTotal = l.data.total;
      appStats = s.data;
    } catch (e) {
      appError = msg(e);
    } finally {
      appsLoading = false;
    }
  }

  function switchTab(next: 'list' | 'apps') {
    tab = next;
    if (next === 'apps' && !apps.length) void loadApps();
  }

  function startReview(r: AppRow) {
    openId = openId === r.id ? null : r.id;
    rejectNote = '';
    appError = '';
    appKind = 'friend';
    form = {
      name: r.name,
      url: r.url,
      description: r.description ?? '',
      avatar: r.avatar ?? '',
      rssUrl: r.rssUrl ?? '',
      note: '',
    };
  }

  /** 通过 = 写入友链表并发布，可同时指定归入哪一组，后端给申请人发信 */
  async function approve(r: AppRow) {
    if (!form.name.trim() || !/^https?:\/\//i.test(form.url.trim())) {
      appError = '站点名称必填，站点地址需以 http(s):// 开头';
      return;
    }
    appsBusy = r.id;
    appError = '';
    appNotice = '';
    try {
      const body: Record<string, unknown> = { publish: true, name: form.name.trim(), url: form.url.trim(), kind: appKind };
      if (form.description.trim()) body.description = form.description.trim();
      if (form.avatar.trim()) body.avatar = form.avatar.trim();
      if (form.rssUrl.trim()) body.rssUrl = form.rssUrl.trim();
      if (form.note.trim()) body.note = form.note.trim();
      const d = await post<{
        data: { synced: boolean; syncError: string | null; state?: 'sent' | 'queued' | 'failed'; notifyError?: string | null };
      }>(`/api/admin/applications/${r.id}/approve`, body);
      const dd = d.data;
      appNotice =
        (dd.synced ? `已通过，写入${KIND_LABEL[appKind]}并触发站点重建` : `已通过${dd.syncError ? `（未写仓库文件：${dd.syncError}）` : '（未写仓库文件）'}`) +
        mailNote(dd);
      openId = null;
      await Promise.all([loadApps(), loadFriends()]);
    } catch (e) {
      appError = msg(e);
    } finally {
      appsBusy = '';
    }
  }

  /** 驳回：理由必填，随邮件发给申请人 */
  async function reject(r: AppRow) {
    if (!rejectNote.trim()) {
      appError = '驳回必须填写理由（会连同结果发送到申请人邮箱）';
      return;
    }
    appsBusy = r.id;
    appError = '';
    appNotice = '';
    try {
      const d = await post<{ data: { state?: 'sent' | 'queued' | 'failed'; notifyError?: string | null } }>(
        `/api/admin/applications/${r.id}/reject`,
        { note: rejectNote.trim() },
      );
      appNotice = `${r.name} 已驳回 ${mailNote(d.data)}`;
      openId = null;
      await loadApps();
    } catch (e) {
      appError = msg(e);
    } finally {
      appsBusy = '';
    }
  }

  /** 当时没配仓库或提交失败的，补一次写文件 */
  async function republish(r: AppRow) {
    appsBusy = r.id;
    appError = '';
    appNotice = '';
    try {
      const d = await post<{ data: { synced: boolean; message?: string } }>(`/api/admin/applications/${r.id}/publish`, {});
      appNotice = d.data.synced ? '已写入友链文件' : `未写入：${d.data.message ?? '检查「设置 → 内容仓库」的仓库坐标、友链文件路径与 GITHUB_TOKEN'}`;
      await Promise.all([loadApps(), loadFriends()]);
    } catch (e) {
      appError = msg(e);
    } finally {
      appsBusy = '';
    }
  }

  async function removeApp(r: AppRow) {
    if (!confirm(`删除 ${r.name} 的申请记录？只是清掉这条申请，不影响已发布的友链。`)) return;
    appsBusy = r.id;
    try {
      await del(`/api/admin/applications/${r.id}`);
      await loadApps();
    } catch (e) {
      appError = msg(e);
    } finally {
      appsBusy = '';
    }
  }

  $effect(() => {
    void loadFriends();
    void loadAppStats();
  });
</script>

<div class="row spread head">
  <h2>友情链接</h2>
  <div class="row">
    <button class="sm" onclick={() => void (tab === 'list' ? loadFriends() : loadApps())} disabled={loading || appsLoading}>
      {tab === 'list' ? (loading ? '刷新中…' : '刷新') : appsLoading ? '读取中…' : '刷新'}
    </button>
    {#if tab === 'list'}
      <button class="sm" onclick={() => void checkNowPost()} disabled={checking}>{checking ? '检测中…' : '立即检测'}</button>
      <button class="sm primary" onclick={reset}>+ 新增友链</button>
    {/if}
  </div>
</div>

<div class="tabs">
  <button class="tab" class:on={tab === 'list'} onclick={() => switchTab('list')}>友链列表 <span class="n">{list.length}</span></button>
  <button class="tab" class:on={tab === 'apps'} onclick={() => switchTab('apps')}>
    待审申请 <span class="n">{appStats.pending ?? 0}</span>
  </button>
</div>

{#if tab === 'list'}
  {#if error}<p class="err">{error}</p>{/if}
  {#if notice}<p class="ok">{notice}</p>{/if}
  {#if checkResult.length}
    <div class="card check">
      {#each checkResult as line (line)}<p class="small">{line}</p>{/each}
      <p class="muted small">检测会访问各站首页与 RSS，连续失败 3 次进入冷却。</p>
    </div>
  {/if}

  {#if showForm}
    <section class="card form">
      <h3>{editId ? '编辑友链' : '新增友链'}</h3>
      <div class="grid2">
        <label>名称 *<input bind:value={name} placeholder="站点名" /></label>
        <label>地址 *<input bind:value={url} placeholder="https://example.com" /></label>
        <label>RSS 地址<input bind:value={rssUrl} placeholder="https://example.com/index.xml" /></label>
        <label>头像<input bind:value={avatar} placeholder="https://…/avatar.png" /></label>
        <label>
          分组
          <select bind:value={fkind} aria-label="归入分组">
            <option value="friend">友链</option>
            <option value="alliance">站点联盟</option>
          </select>
        </label>
      </div>
      <label>简介<input bind:value={description} placeholder="一句话介绍（≤200 字）" /></label>
      <div class="row">
        <button class="primary" onclick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button onclick={() => (showForm = false)}>取消</button>
      </div>
    </section>
  {/if}

  <div class="row spread sortbar">
    <span class="muted small">
      {#if sortMode}用 ↑ / ↓ 调整同组顺序，点「保存顺序」写入 sortOrder（POST /api/admin/friends/reorder）。{/if}
    </span>
    <div class="row">
      {#if !sortMode}
        <button class="sm" onclick={enterSort}>排序</button>
      {:else}
        <button class="sm" onclick={cancelSort} disabled={savingOrder}>取消</button>
        <button class="sm primary" onclick={() => void saveOrder()} disabled={savingOrder}>{savingOrder ? '保存中…' : '保存顺序'}</button>
      {/if}
    </div>
  </div>

  {#each KIND_ORDER as kind (kind)}
    {@const items = viewGroups[kind]}
    <section class="card grp">
      <div class="row spread grph">
        <h3>{KIND_LABEL[kind]}</h3>
        <span class="muted small">{items.length} 条</span>
      </div>
      {#if !items.length}
        <p class="muted small">{kind === 'alliance' ? '还没有站点联盟成员，可在友链条目上「移到站点联盟」。' : '还没有友链，点击右上角新增。'}</p>
      {/if}
      {#each items as f, i (f.id)}
        <div class="frow">
          <div class="fmain">
            {#if f.avatar}<img class="av" src={assetUrl(f.avatar) || f.avatar} alt="" loading="lazy" />{/if}
            <div class="ftext">
              <a class="flink" href={f.url} target="_blank" rel="noreferrer noopener" title={f.url}>{f.name}</a>
              {#if f.description}<p class="muted small desc" title={f.description}>{f.description}</p>{/if}
              <div class="row fmeta">
                <span class="badge {f.status === 'active' ? 'good' : f.status === 'dead' ? 'bad' : 'pending'}">{statusText(f)}</span>
                {#if f.failCount > 0}<span class="muted small">失败 {f.failCount} 次</span>{/if}
                <span class="muted small">#{f.sortOrder}</span>
                <span class="muted small">{f.lastCheckedAt ? fmtDate(f.lastCheckedAt) : '未检测'}</span>
              </div>
            </div>
          </div>
          <div class="fops">
            {#if sortMode}
              <button class="sm" onclick={() => moveWithin(kind, i, -1)} disabled={i === 0} title="上移">↑</button>
              <button class="sm" onclick={() => moveWithin(kind, i, 1)} disabled={i === items.length - 1} title="下移">↓</button>
            {:else}
              <button class="sm ghost" onclick={() => moveKind(f)}>{kind === 'alliance' ? '移到友链' : '移到联盟'}</button>
              <button class="sm" onclick={() => startEdit(f)}>编辑</button>
              <button class="sm danger" onclick={() => void remove(f)}>删除</button>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/each}
{:else}
  <div class="tabs sub">
    {#each APP_TABS as [key, label] (key)}
      <button
        class="tab"
        class:on={appTab === key}
        onclick={() => {
          appTab = key;
          openId = null;
          void loadApps();
        }}>
        {label} <span class="n">{key === 'all' ? appStats.total ?? 0 : appStats[key] ?? 0}</span>
      </button>
    {/each}
    <input class="search" placeholder="按名称 / 网址筛选" bind:value={appQ} onkeydown={(e) => e.key === 'Enter' && loadApps()} />
    <span class="muted small right">共 {appTotal} 条</span>
  </div>

  {#if appError}<p class="err">{appError}</p>{/if}
  {#if appNotice}<p class="ok">{appNotice}</p>{/if}

  <div class="card">
    <div class="table-wrap">
      <table class="cols-wide">
        <thead>
          <tr>
            <th>站点名</th>
            <th>站点地址</th>
            <th>站长邮箱</th>
            <th>RSS</th>
            <th>状态</th>
            <th>提交于</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each apps as r (r.id)}
            <tr>
              <td>{r.name}</td>
              <td><a class="flink" href={r.url} target="_blank" rel="noreferrer" title={r.url}>{r.url}</a></td>
              <td class="small">{r.email || '—'}</td>
              <td class="small">{r.rssUrl ? '✓' : '—'}</td>
              <td>
                <span class="badge {r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'pending'}">
                  {r.status === 'approved' ? (r.publishedFriendId ? '已发布' : '已通过') : r.status === 'rejected' ? '已驳回' : '待审'}
                </span>
              </td>
              <td class="small muted" title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
              <td class="ops">
                {#if r.status === 'pending'}
                  <button class="sm primary" onclick={() => startReview(r)} disabled={appsBusy === r.id}>
                    {openId === r.id ? '收起' : '审核'}
                  </button>
                {:else if r.status === 'approved' && !r.publishedFriendId}
                  <button class="sm" onclick={() => void republish(r)} disabled={appsBusy === r.id}>补发</button>
                {/if}
                <button class="sm danger" onclick={() => void removeApp(r)} disabled={appsBusy === r.id}>删</button>
              </td>
            </tr>
            {#if openId === r.id}
              <tr class="detail">
                <td colspan="7">
                  <div class="apply">
                    <dl class="fields3">
                      <div><dt>站点名称</dt><dd>{r.name}</dd></div>
                      <div><dt>站点地址（friendLink）</dt><dd><a class="flink" href={r.url} target="_blank" rel="noreferrer" title={r.url}>{r.url}</a></dd></div>
                      <div><dt>站长邮箱</dt><dd>{r.email || '—（未填，无法发信）'}</dd></div>
                      <div><dt>RSS</dt><dd>{r.rssUrl || '—'}</dd></div>
                      <div><dt>头像</dt><dd>{r.avatar || '—'}</dd></div>
                      <div><dt>简介</dt><dd>{r.description || '—'}</dd></div>
                      <div class="span"><dt>申请理由</dt><dd>{r.reason || '—'}</dd></div>
                      <div class="span"><dt>来源 / 时间</dt><dd>{r.ip || '未知地址'} · {fmtDate(r.createdAt)}</dd></div>
                      {#if r.reviewNote}<div class="span"><dt>上次审核备注</dt><dd>{r.reviewNote}</dd></div>{/if}
                    </dl>
                  </div>

                  {#if r.status === 'pending'}
                    <p class="muted small">可微调后再通过；通过后自动写入所选分组并发布，审核结果会发送到上面的邮箱。</p>
                    <div class="grid2">
                      <label>站点名称 *<input bind:value={form.name} maxlength="60" /></label>
                      <label>站点地址 *<input bind:value={form.url} maxlength="300" /></label>
                      <label>简介<input bind:value={form.description} maxlength="200" /></label>
                      <label>头像地址<input bind:value={form.avatar} placeholder="选填" /></label>
                      <label>RSS 地址<input bind:value={form.rssUrl} placeholder="选填" /></label>
                      <label>
                        归入分组
                        <select bind:value={appKind} aria-label="归入分组">
                          <option value="friend">友链</option>
                          <option value="alliance">站点联盟</option>
                        </select>
                      </label>
                      <label>审核备注<input bind:value={form.note} placeholder="只留在后台记录" maxlength="300" /></label>
                    </div>
                    <div class="row acts">
                      <span class="grow"></span>
                      <button class="sm" onclick={() => (openId = null)}>取消</button>
                      <button class="sm primary" onclick={() => void approve(r)} disabled={appsBusy === r.id}>
                        {appsBusy === r.id ? '处理中…' : '通过并发布'}
                      </button>
                    </div>
                    <div class="row note">
                      <input class="wide" placeholder="驳回理由（必填，会写进驳回邮件）" bind:value={rejectNote} maxlength="300" />
                      <button class="sm danger" onclick={() => void reject(r)} disabled={appsBusy === r.id}>驳回并通知</button>
                    </div>
                  {/if}
                </td>
              </tr>
            {/if}
          {:else}
            <tr><td colspan="7" class="muted">{appsLoading ? '加载中…' : '这个状态下没有申请'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<style>
  .head {
    margin-bottom: 0.7rem;
  }
  .tabs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.7rem;
  }
  .tabs.sub {
    margin-top: 0.2rem;
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
  .tab .n {
    opacity: 0.75;
    font-size: 0.76rem;
  }
  .right {
    margin-left: auto;
  }
  .search {
    width: 200px;
  }
  .form,
  .check {
    margin-bottom: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .check p {
    margin: 0.15rem 0;
  }
  .sortbar {
    margin: 0.2rem 0 0.7rem;
    min-height: 1.4rem;
  }
  .grp {
    margin-bottom: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .grph h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .frow {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    justify-content: space-between;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }
  .fmain {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex: 1;
  }
  .ftext {
    min-width: 0;
  }
  .flink {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    font-weight: 600;
  }
  .desc {
    margin: 0.1rem 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fmeta {
    gap: 0.5rem;
  }
  .av {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--accent-soft);
    flex: none;
  }
  .fops {
    display: flex;
    gap: 0.3rem;
    flex: none;
    white-space: nowrap;
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.6rem;
    margin-bottom: 0.6rem;
  }
  .small {
    font-size: 0.76rem;
  }
  .ops {
    justify-content: flex-end;
    white-space: nowrap;
  }
  .ops button + button {
    margin-left: 0.3rem;
  }
  .detail td {
    background: #fafafa;
  }
  .apply {
    padding: 0.2rem 0 0.4rem;
  }
  .fields3 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.35rem 1rem;
    margin: 0;
  }
  .fields3 div {
    min-width: 0;
  }
  .fields3 .span {
    grid-column: 1 / -1;
  }
  .fields3 dt {
    font-size: 0.72rem;
    color: var(--muted);
  }
  .fields3 dd {
    margin: 0 0 0.25rem;
    font-size: 0.84rem;
    overflow-wrap: anywhere;
  }
  .acts {
    margin-top: 0.4rem;
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
</style>
