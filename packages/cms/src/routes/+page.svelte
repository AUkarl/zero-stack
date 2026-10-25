<script lang="ts">
  import { get, siteOf } from '#lib/api';
  import LineChart from '#lib/LineChart.svelte';

  interface Summary {
    totalViews: number;
    totalVisitors: number;
    todayViews: number;
    todayVisitors: number;
    onlineNow: number;
    avgDurationSeconds: number;
  }

  let summary = $state<Summary | null>(null);
  let content = $state<{
    comments: number;
    subscribers: number;
    users: number;
    posts?: number;
    moments?: number;
    postsDir?: string;
    momentsDir?: string;
    capped?: boolean;
    contentError?: string;
  } | null>(null);
  let trend = $state<{ day: string; views: number; visitors: number }[]>([]);
  let devices = $state<Record<string, { k: string; n: number }[]>>({});
  let top = $state<{ site?: string; pages: { path: string; views: number }[]; referrers: { referrer: string; views: number }[] }>({
    pages: [],
    referrers: [],
  });
  let health = $state<any>(null);
  /** 内容仓最近一次构建结果（CI 回报）。null = 从没回报过，界面不显示任何一行 */
  let buildReport = $state<{ status: string; sha: string; branch: string; error: string; at: number } | null>(null);
  let buildReportNotice = $state<string | null>(null);
  let error = $state('');
  let loading = $state(true);

  async function loadAll() {
    loading = true;
    error = '';
    try {
      const [s, st, tr, dv, tp, hd, br] = await Promise.all([
        get<{ data: Summary }>('/api/analytics/summary'),
        get<{ data: any }>('/api/admin/stats'),
        get<{ data: { day: string; views: number; visitors: number }[] }>('/api/analytics/trend?days=30'),
        get<{ data: Record<string, { k: string; n: number }[]> }>('/api/analytics/devices'),
        get<{ data: any }>('/api/analytics/top'),
        get<{ data: any }>('/api/admin/health-detail'),
        // 构建回报是后加的，老站点没配令牌时它给 notice；这份失败不能把整个仪表板带崩
        get<{ data: { last: typeof buildReport; notice: string | null } }>('/api/build-report').catch(() => null),
      ]);
      summary = s.data;
      content = {
        comments: st.data.comments,
        subscribers: st.data.subscribers,
        users: st.data.users,
      };
      trend = tr.data;
      devices = dv.data;
      top = tp.data;
      health = hd.data;
      buildReport = br?.data?.last ?? null;
      buildReportNotice = br?.data?.notice ?? null;
      try {
        const cs = await get<{
          data: { posts: number; moments: number; postsDir: string; momentsDir: string; capped?: boolean; error?: string };
        }>('/api/admin/stats/content');
        if (content) {
          content.posts = cs.data.posts;
          content.moments = cs.data.moments;
          content.postsDir = cs.data.postsDir;
          content.momentsDir = cs.data.momentsDir;
          content.capped = cs.data.capped;
          content.contentError = cs.data.error;
        }
      } catch (e) {
        if (content) content.contentError = e instanceof Error ? e.message : '内容仓库读取失败';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : '数据加载失败';
    } finally {
      loading = false;
    }
  }

  $effect(() => void loadAll());

  const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`);
  const DEVICE_LABELS: Record<string, string> = { device: '设备', browser: '浏览器', os: '系统', country: '地区' };

  // 长链接中间省略：保留头尾、中段用 …，完整值交给 title 悬浮查看
  function mid(raw: string | null | undefined, head = 24, tail = 14): string {
    const s = String(raw ?? '');
    if (s.length <= head + tail + 1) return s;
    return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
  }

  /* 定时任务的中文名由接口一起给（`jobs[].label`，名单在 API 的 services/scheduler.ts）。
     这里以前自己抄了一份：任务改了名字这边不知道，界面上 10 条里 7 条显示成英文键，
     另外 3 条标签指向根本不存在的任务 —— 两份名单迟早分家，所以现在只留一处。 */

  function sinceText(ts: number): string {
    const d = Math.floor(Date.now() / 1000) - ts;
    if (d < 60) return `${d} 秒前`;
    if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
    if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
    return `${Math.floor(d / 86400)} 天前`;
  }

  /**
   * 运行状况的胶囊。两处改动：
   * ① 后端 cron 以前回的是 { recent: [...] }，界面按数组判断 length，永远为假，
   *    跑过的任务也一律显示「尚未执行过」；现在后端回数组，这里也只认数组。
   * ② 胶囊从「Object.entries 全铺」改成写死的清单：多一个 check 键就凭空多一个没名字的胶囊。
   */
  const pillDefs = $derived.by(() => {
    const chk = health?.checks ?? {};
    const email = chk.email ?? {};
    return [
      { key: 'd1', label: '数据库', ok: chk.d1?.ok !== false, detail: chk.d1?.detail ?? '', tip: 'D1 连通性：select 1 是否成功' },
      { key: 'r2', label: '对象存储', ok: chk.r2?.ok !== false, detail: chk.r2?.detail ?? '', tip: '只数私有桶（绑定 R2，默认 zero-media）里的对象：分页翻完，超过 5 万个标 +。公开桶与 media 桶不在此列' },
      { key: 'kv', label: '缓存', ok: chk.kv?.ok !== false, detail: chk.kv?.detail ?? '', tip: 'KV 命名空间里的键数：分页翻完，超过 5 万个标 +' },
      { key: 'queue', label: '发信队列', ok: chk.emailQueue?.ok !== false, detail: chk.emailQueue?.detail ?? '', tip: 'EMAIL_QUEUE 绑定是否存在' },
      {
        key: 'repo',
        label: '内容仓库',
        ok: !content?.contentError,
        detail: content?.contentError ? '读取失败' : `文章 ${content?.posts ?? 0} · 时刻 ${content?.moments ?? 0}`,
        tip: content?.contentError ?? `递归数 .md：文章目录 ${content?.postsDir ?? ''}、时刻目录 ${content?.momentsDir ?? ''}`,
      },
      {
        key: 'email',
        label: '发信',
        ok: email.secretConfigured !== false,
        detail: `${email.provider ?? 'smtp'}${email.credentialSource ? ` · ${email.credentialSource}` : ''}`,
        tip: `凭据来源：${email.credentialSource ?? '未配置'}（后台填的密码与 wrangler secret 任一即可）；SMTP 主机 ${email.host || '未填'}，发件人 ${email.from || '未填'}`,
      },
      {
        key: 'purge',
        label: '边缘清缓存',
        ok: chk.purge?.ok !== false,
        detail: chk.purge?.detail ?? '',
        tip:
          '删文章 / 改地址后要把那条 URL 从 Cloudflare 边缘清掉。没配就得去控制台手动清一次 —— ' +
          '不配不会报错，只会「后台删了、老链接还能打开 7 天，访客强刷也没用」。' +
          '在「设置 → 内容仓库」填 Zone ID 与一个只给 Zone-Cache-Purge 权限的令牌。',
      },
    ];
  });

  const badChecks = $derived(pillDefs.filter((p) => !p.ok));
  const cronJobs = $derived.by(() => {
    const rows = health?.checks?.cron;
    return Array.isArray(rows) ? rows : [];
  });
</script>

<div class="head row spread">
  <h2>仪表盘</h2>
  <div class="row">
    <span class="muted">30 秒内数据为缓存</span>
    <button onclick={() => void loadAll()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
  </div>
</div>

{#if error}<p class="err">{error}</p>{/if}

<div class="cards">
  {#each [
    ['总访问量', summary?.totalViews, ''],
    ['今日访问', summary?.todayViews, ''],
    ['独立访客', summary?.totalVisitors, ''],
    ['实时在线', summary?.onlineNow, '5 分钟窗口'],
    ['平均停留', summary ? fmtDur(summary.avgDurationSeconds) : ''],
  ] as [label, v, note] (label)}
    <div class="card stat"><span class="v">{v ?? '—'}</span><span class="l">{label}</span>{#if note}<span class="n">{note}</span>{/if}</div>
  {/each}
</div>

<div class="cards four">
  {#each [
    ['文章', content?.posts, content?.contentError ? '内容仓库读不到' : content?.capped ? '目录递归 .md（数量已达上限）' : '目录递归 .md'],
    ['时刻', content?.moments, content?.contentError ? '内容仓库读不到' : '目录递归 .md'],
    ['评论', content?.comments, ''],
    ['订阅者', content?.subscribers, '已确认'],
    ['用户', content?.users, ''],
  ] as [label, v, note] (label)}
    <div class="card stat"><span class="v">{v ?? '—'}</span><span class="l">{label}</span>{#if note}<span class="n">{note}</span>{/if}</div>
  {/each}
</div>

<div class="grid">
  <div class="card">
    <h3>近 30 天访问趋势</h3>
    {#if trend.length}
      <LineChart
        labels={trend.map((t) => t.day)}
        series={[
          { name: '浏览量', color: '#2563eb', values: trend.map((t) => t.views) },
          { name: '访客', color: '#f59e0b', values: trend.map((t) => t.visitors) },
        ]}
      />
    {:else}<p class="muted">暂无数据</p>{/if}
  </div>

  <div class="card">
    <h3>分布</h3>
    {#each Object.entries(devices) as [key, rows] (key)}
      <div class="dist">
        <h4>{DEVICE_LABELS[key] ?? key}</h4>
        {#each rows as r (r.k)}
          <div class="bar-row">
            <span class="k">{r.k || '未知'}</span>
            <span class="bar"><i style="width:{Math.min(100, (r.n / Math.max(1, rows[0]?.n ?? 1)) * 100)}%"></i></span>
            <span class="n">{r.n}</span>
          </div>
        {:else}
          <p class="muted">—</p>
        {/each}
      </div>
    {/each}
  </div>

  <div class="card">
    <h3>热门页面 Top 10</h3>
    <ol class="tops">
      {#each top.pages as p (p.path)}
        <li>
          {#if siteOf(top.site, p.path)}
            <a class="url" href={siteOf(top.site, p.path)} target="_blank" rel="noreferrer" title={p.path}>{mid(p.path)}</a>
          {:else}
            <span class="url muted" title={p.path}>{mid(p.path)}</span>
          {/if}
          <span class="cnt">{p.views}</span>
        </li>
      {:else}
        <li class="muted">暂无</li>
      {/each}
    </ol>
  </div>

  <div class="card">
    <h3>来源 Top 10</h3>
    <ol class="tops">
      {#each top.referrers as r (r.referrer)}
        <li>
          <span class="url" title={r.referrer}>{mid(r.referrer) || '直接访问'}</span>
          <span class="cnt">{r.views}</span>
        </li>
      {:else}
        <li class="muted">暂无</li>
      {/each}
    </ol>
  </div>

  <!--
    内容仓构建结果。这一块补的是线上唯一剩下的那种「静默失败」：
    站点构建挂了（Pages 构建失败就不换部署），后台每笔保存照样回「已保存」，
    前台从此停在旧版。本地有桥能自己跑体检（见「文章」页那条红字），
    线上跑不了子进程，只能由跑构建的那一侧报回来 —— 见 /api/build-report。
  -->
  {#if buildReport?.status === 'failure'}
    <div class="card wide">
      <h3>站点构建</h3>
      <p class="err">
        最近一次内容仓构建<strong>失败</strong>（{sinceText(buildReport.at)}，提交
        {buildReport.sha?.slice(0, 7) || '未知'}{buildReport.branch ? ` / ${buildReport.branch}` : ''}）。
        Pages 构建失败就不换部署，<strong>前台现在停在上一版</strong>，后台的保存与群发看起来都仍然正常。
        {#if buildReport.error}
          <br />构建日志末尾：<code class="log">{buildReport.error.slice(0, 800)}</code>
        {/if}
      </p>
    </div>
  {:else if buildReport}
    <div class="card wide">
      <div class="row spread">
        <h3>站点构建</h3>
        <span class="muted">最近一次构建成功（{sinceText(buildReport.at)}，提交 {buildReport.sha?.slice(0, 7) || '未知'}）</span>
      </div>
    </div>
  {:else if buildReportNotice}
    <div class="card wide">
      <h3>站点构建</h3>
      <p class="muted">{buildReportNotice}</p>
    </div>
  {/if}

  <div class="card wide">
    <div class="row spread">
      <h3>运行状况</h3>
      {#if health}
        <span class="muted">
          {badChecks.length ? `${badChecks.length} 项异常` : '全部正常'} · API 延迟 {health.checks?.apiLatencyMs ?? 0}ms
        </span>
      {/if}
    </div>
    {#if health}
      <div class="health">
        {#each pillDefs as p (p.key)}
          <span class="pill" class:good={p.ok} class:bad={!p.ok} title={p.tip}>
            {p.label}{#if p.detail} · {p.detail}{/if}
          </span>
        {/each}
      </div>
      {#if badChecks.length}
        <p class="err">
          异常项：{badChecks.map((b) => `${b.label} — ${b.detail}`).join('；')}
        </p>
      {/if}
      {#if cronJobs.length}
        <div class="table-wrap">
          <table class="jobs">
            <thead>
              <tr>
                <th>定时任务</th>
                <th>状态</th>
                <th>最近一次开始</th>
                <th>距今</th>
                <th>耗时</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {#each cronJobs as j (j.name)}
                <tr>
                  <td>{j.label ?? j.name}</td>
                  <td><span class="badge" class:good={j.status === 'ok'} class:bad={j.status !== 'ok'}>{j.status}</span></td>
                  <td class="muted">{new Date(j.startedAt * 1000).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td class="muted">{sinceText(j.startedAt)}</td>
                  <td class="muted">{j.finishedAt ? `${Math.max(0, j.finishedAt - j.startedAt)} 秒` : '—'}</td>
                  <td class="muted">{j.detail ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="muted">
          还没有任何一次定时任务记录。Cron 在世界时 02:00（北京 10:00）跑一次；也可以在「设置」页底部手动触发。
        </p>
      {/if}
    {:else}
      <p class="muted">加载中…</p>
    {/if}
  </div>
</div>

<style>
  .head {
    margin-bottom: 0.9rem;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
    gap: 0.7rem;
    margin-bottom: 0.7rem;
  }
  .cards.four {
    margin-bottom: 1rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.85rem 1rem;
  }
  .stat .v {
    font-size: 1.45rem;
    font-weight: 700;
  }
  .stat .l {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .stat .n {
    color: #b7bcc4;
    font-size: 0.72rem;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
    gap: 0.9rem;
  }
  .card.wide {
    grid-column: 1 / -1;
  }
  .dist h4 {
    margin: 0.6rem 0 0.25rem;
    font-size: 0.82rem;
    color: var(--muted);
    font-weight: 600;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 88px 1fr 42px;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.82rem;
    padding: 1px 0;
  }
  .bar-row .k {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-row .bar {
    background: var(--accent-soft);
    border-radius: 4px;
    height: 10px;
    overflow: hidden;
  }
  .bar-row .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
  }
  .bar-row .n {
    text-align: right;
    color: var(--muted);
  }
  .tops {
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: t;
  }
  .tops li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.6rem;
    align-items: center;
    padding: 0.3rem 0;
    border-bottom: 1px dashed var(--border);
    font-size: 0.86rem;
  }
  .tops li span:last-child {
    color: var(--muted);
  }
  .tops .url {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tops .cnt {
    color: var(--muted);
    white-space: nowrap;
  }
  .health {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin: 0.3rem 0 0.8rem;
  }
  .pill {
    font-size: 0.8rem;
    border-radius: 999px;
    padding: 0.15rem 0.7rem;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .pill.good {
    border-color: #bbf7d0;
    background: #f0fdf4;
    color: var(--good);
  }
  .pill.bad {
    border-color: #fecaca;
    background: #fef2f2;
    color: var(--bad);
  }
  .jobs td {
    font-size: 0.84rem;
  }
  @media (max-width: 900px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .cards,
    .cards.four {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
