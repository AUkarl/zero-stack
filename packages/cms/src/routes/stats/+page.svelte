<script lang="ts">
  import { fmtDate, get, post, siteOf } from '#lib/api';
  import LineChart from '#lib/LineChart.svelte';

  interface Summary {
    totalViews: number;
    totalVisitors: number;
    todayViews: number;
    todayVisitors: number;
    onlineNow: number;
    avgDurationSeconds: number;
    /**
     * 后端 summary 的按 IP 去重口径（analytics.ts 用 visits.ip_hash，老行退回 session_id）：
     *   todayUniqueIpVisitors 今日独立访客、totalUniqueIpVisitors 建站以来累计独立访客、
     *   allTimeViews 建站以来累计浏览量（后三项来自 site_config 计数器，analytics:prune 删明细也不影响）
     * 缺字段就显示占位并在页面下方说明口径，绝不拿会话数冒充实人数。
     */
    todayUniqueIpVisitors?: number;
    totalUniqueIpVisitors?: number;
    allTimeViews?: number;
    /** 明细保留天数 + 口径说明，statsMeta() 生成 */
    retentionDays?: number;
    retentionNote?: string;
    /** 本 isolate 这一小时里被 isBot() 判掉、没入库的 /beat 条数（冷启动清零，不是全站累计） */
    botFilteredThisHour?: number;
    botFilteredNote?: string;
  }
  interface Point {
    day: string;
    views: number;
    /** 后端已改成按 ip_hash 去重；字段名沿用 visitors */
    visitors: number;
    /** 旧字段名，后端没回时退回 visitors */
    uniqueIpVisitors?: number;
  }
  interface Devices {
    device: { k: string; n: number }[];
    browser: { k: string; n: number }[];
    os: { k: string; n: number }[];
    country: { k: string; n: number }[];
  }
  interface Top {
    site?: string;
    /** 后端窗口：含今天在内共 days 天，与趋势图同一个区间 */
    days?: number;
    pages: { path: string; views: number; visitors?: number }[];
    referrers: { referrer: string; views: number; visitors?: number }[];
  }
  interface Biz {
    comments: number;
    pendingComments: number;
    subscribers: number;
    users: number;
    email: Record<string, number>;
  }
  /** 按页面汇总的点赞 / 收藏：票数远大于 actors 就是刷出来的 */
  interface ReactionRow {
    slug: string;
    likes: number;
    stars: number;
    actors: number;
    lastAt: number;
  }
  interface ReactionStats {
    rows: ReactionRow[];
    reactionRows: number;
    pages: number;
  }

  let summary = $state<Summary | null>(null);
  let trend = $state<Point[]>([]);
  let devices = $state<Devices | null>(null);
  let top = $state<Top | null>(null);
  let biz = $state<Biz | null>(null);
  let reactions = $state<ReactionStats | null>(null);
  /** 文章地址 → 标题：/api/admin/posts 是后端缓存过的那份，这里只做显示用，取不到就原样给地址 */
  let titles = $state<Record<string, string>>({});
  let days = $state(14);
  let loading = $state(false);
  let error = $state('');
  let enabled = $state(true);

  async function load() {
    loading = true;
    error = '';
    try {
      const [s, t, dv, tp, bz, rx, ps, cfg] = await Promise.all([
        get<{ data: Summary }>('/api/analytics/summary'),
        get<{ data: Point[] }>(`/api/analytics/trend?days=${days}`),
        get<{ data: Devices }>('/api/analytics/devices'),
        get<{ data: Top }>('/api/analytics/top'),
        get<{ data: Biz }>('/api/admin/stats'),
        get<{ data: ReactionStats }>('/api/admin/stats/reactions?limit=30'),
        get<{ data: { path: string; title: string }[] }>('/api/admin/posts'),
        get<{ data: Record<string, string> }>('/api/admin/config'),
      ]);
      summary = s.data;
      trend = t.data;
      devices = dv.data;
      top = tp.data;
      biz = bz.data;
      reactions = rx.data;
      const map: Record<string, string> = {};
      for (const p of ps.data ?? []) {
        const stem = (p.path.match(/([^/]+)\.mdx?$/i) ?? [])[1] ?? '';
        if (stem && /(^|\/)posts\//.test(p.path)) map[`/posts/${stem}/`] = p.title;
      }
      titles = map;
      enabled = cfg.data.analyticsEnabled !== 'false';
    } catch (e) {
      error = e instanceof Error ? e.message : '读取统计失败';
    } finally {
      loading = false;
    }
  }

  const hasIp = $derived(summary ? typeof summary.todayUniqueIpVisitors === 'number' : false);
  const hasIpTrend = $derived(trend.some((p) => typeof p.uniqueIpVisitors === 'number'));
  const hasLifetime = $derived(
    summary ? typeof summary.allTimeViews === 'number' && typeof summary.totalUniqueIpVisitors === 'number' : false,
  );
  const visitorName = $derived(
    hasIp || hasIpTrend ? '独立访客（按 IP 去重）' : '访客数（按会话，后端待补 IP 去重字段）',
  );

  const series = $derived([
    { name: '访问量', color: '#2563eb', values: trend.map((p) => p.views) },
    { name: visitorName, color: '#16a34a', values: trend.map((p) => p.uniqueIpVisitors ?? p.visitors) },
  ]);
  const labels = $derived(trend.map((p) => p.day));

  const dims = $derived.by((): [string, { k: string; n: number }[]][] => {
    if (!devices) return [];
    return [
      ['设备', devices.device],
      ['浏览器', devices.browser],
      ['系统', devices.os],
      ['地区', devices.country],
    ];
  });

  function pct(list: { k: string; n: number }[]): { k: string; n: number; p: number }[] {
    const sum = list.reduce((a, b) => a + b.n, 0) || 1;
    return list.map((x) => ({ ...x, p: Math.round((x.n / sum) * 100) }));
  }

  // 长路径 / 长来源中间省略，完整值留在 title，列宽固定不撑破表格
  function mid(raw: string | null | undefined, head = 30, tail = 16): string {
    const s = String(raw ?? '');
    if (s.length <= head + tail + 1) return s;
    return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
  }

  let exporting = $state(false);
  let exportNote = $state('');

  /**
   * 立刻把每篇的阅读 / 评论 / 点赞 / 收藏导出成站点 data/poststats.json。
   * 定时任务每天跑一次，改完开关或刚发新文章时可以手点一次，首页精选与「最热」下一次构建就按新数据排。
   */
  async function exportStats() {
    if (exporting) return;
    exporting = true;
    exportNote = '';
    error = '';
    try {
      const res = await post<{ data: { detail: string } }>('/api/admin/poststats/export', {});
      exportNote = res.data?.detail || '已导出';
    } catch (e) {
      error = e instanceof Error ? e.message : '导出失败';
    } finally {
      exporting = false;
    }
  }

  $effect(() => void load());
</script>

<div class="row spread head">
  <h2>访问统计</h2>
  <div class="row">
    <select bind:value={days} onchange={() => void load()}>
      <option value={7}>近 7 天</option>
      <option value={14}>近 14 天</option>
      <option value={30}>近 30 天</option>
      <option value={90}>近 90 天</option>
    </select>
    <button class="sm" onclick={() => void exportStats()} disabled={exporting} title="导出 data/poststats.json，供首页精选与「最热」构建期排序">
      {exporting ? '导出中…' : '导出文章统计'}
    </button>
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
  </div>
</div>

{#if exportNote}<p class="ok small">统计导出：{exportNote}</p>{/if}

{#if !enabled}<p class="warn">统计开关当前是关闭的（设置 - 访问统计），前台不再上报页面浏览。</p>{/if}
{#if error}<p class="err">{error}</p>{/if}

<div class="kpis">
  {#each [
      { label: '今日访问', value: summary?.todayViews ?? '—', tip: '今日页面浏览次数' },
      {
        label: '独立访客（按 IP 去重）',
        value: summary?.todayUniqueIpVisitors ?? '—',
        tip: hasIp ? '今日按访客 IP 哈希去重的人数' : '后端 analytics/summary 未返回 todayUniqueIpVisitors，暂无法统计',
      },
      { label: '当前在线', value: summary?.onlineNow ?? '—', tip: '最近 5 分钟活跃访客（同样按 IP 去重）' },
      {
        label: '建站以来累计访问人数',
        value: summary?.totalUniqueIpVisitors ?? '—',
        tip: hasLifetime
          ? '全站历史按 IP 去重的访客总数；记在 site_config 计数器里，明细到保留期被清理也不会变小'
          : '后端 analytics/summary 未返回 totalUniqueIpVisitors，暂无法统计',
      },
      {
        label: '累计访问量',
        value: summary?.allTimeViews ?? summary?.totalViews ?? '—',
        tip: hasLifetime ? '建站以来的页面浏览总次数，不受到期清理影响' : '后端未返回 allTimeViews，这里显示的是现存明细的浏览总数',
      },
      { label: '平均停留', value: summary ? `${Math.round(summary.avgDurationSeconds)} 秒` : '—', tip: '近 7 天会话平均停留' },
    ] as k (k.label)}
    <div class="card kpi" title={k.tip}>
      <span class="v">{k.value}</span>
      <span class="muted l">{k.label}</span>
    </div>
  {/each}
</div>

{#if summary && hasIp}
  <p class="muted small ipnote">
    访客口径：按加盐哈希后的访客 IP 去重（迁移前没有哈希的老记录退回会话指纹）。{summary.retentionNote || ''}
    其余「今日 / 明细」类数字只覆盖保留期内的明细。
    浏览量为页面浏览次数（同一人刷新多次算多次），爬虫与监控探针的访问不入库
    {#if typeof summary.botFilteredThisHour === 'number'}
      （本实例这一小时里被判为机器人并丢弃的是 <b>{summary.botFilteredThisHour}</b> 条——
      冷启动会清零，不是全站累计；「今天数字为什么少了一半」先看这一条再猜）
    {:else}
      ；
    {/if}
    「今日」的日界按后台配置键 statsUtcOffsetHours（默认东八区 8）切，不再是 UTC 零点。
  </p>
{/if}

{#if summary && !hasIp}
  <p class="muted small ipnote">
    访客口径说明：后端 <code>/api/analytics/summary</code> 没有返回 <code>todayUniqueIpVisitors</code> /
    <code>totalUniqueIpVisitors</code> / <code>allTimeViews</code> 这几个按 IP 去重的字段（旧版接口，
    只能给出 {summary.totalVisitors} 这个累计访客数），所以「独立访客」「建站以来累计访问人数」显示为 —、
    「累计访问量」退回累计总访问量。后端补上字段后本页自动生效。
  </p>
{/if}

<section class="card">
  <h3>趋势</h3>
  {#if labels.length}
    <LineChart {series} {labels} height={190} />
  {:else}
    <p class="muted small">还没有数据。</p>
  {/if}
</section>

<div class="cols">
  <section class="card">
    <h3>热门页面</h3>
    {#if top?.pages?.length}
    <div class="table-wrap">
        <table>
          <thead><tr><th>页面</th><th class="num">浏览</th><th class="num">访客</th></tr></thead>
          <tbody>
            {#each top.pages as p (p.path)}
              <tr>
                <td class="path">
                  {#if siteOf(top.site, p.path)}
                    <a href={siteOf(top.site, p.path)} target="_blank" rel="noreferrer" title={p.path}>{mid(p.path)}</a>
                  {:else}
                    <span class="muted" title={p.path}>{mid(p.path)}</span>
                  {/if}
                </td>
                <td class="num">{p.views}</td>
                <td class="num">{p.visitors ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
    </div>
    {:else}<p class="muted small">暂无页面记录。</p>{/if}
  </section>

  <section class="card">
    <h3>来源</h3>
    {#if top?.referrers?.length}
    <div class="table-wrap">
        <table>
          <thead><tr><th>来源</th><th class="num">浏览</th><th class="num">访客</th></tr></thead>
          <tbody>
            {#each top.referrers as r (r.referrer)}
              <tr>
                <td class="path" title={r.referrer}>{mid(r.referrer) || '直接访问'}</td>
                <td class="num">{r.views}</td>
                <td class="num">{r.visitors ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
    </div>
    {:else}<p class="muted small">全部是直接访问。</p>{/if}
  </section>

  {#each dims as [title, list] (title)}
    <section class="card">
      <h3>{title}</h3>
      {#if list.length}
        {#each pct(list) as x (x.k)}
          <div class="bar">
            <span class="bl">{x.k || '未知'}</span>
            <span class="track"><span class="fill" style="width:{x.p}%"></span></span>
            <span class="bn">{x.n}</span>
          </div>
        {/each}
      {:else}<p class="muted small">暂无。</p>{/if}
    </section>
  {/each}
</div>

<section class="card biz">
  <h3>站点数据</h3>
  {#if biz}
    <div class="kpis">
      {#each [
          { label: '评论总数', value: biz.comments },
          { label: '待审评论', value: biz.pendingComments },
          { label: '订阅者', value: biz.subscribers },
          { label: '注册用户', value: biz.users },
          { label: '邮件已发', value: biz.email?.sent ?? 0 },
          { label: '邮件失败', value: biz.email?.failed ?? 0 },
        ] as k (k.label)}
        <div class="kpi plain">
          <span class="v">{k.value}</span>
          <span class="muted l">{k.label}</span>
        </div>
      {/each}
    </div>
  {:else}
    <p class="muted small">读取中…</p>
  {/if}
</section>

<section class="card">
  <h3>点赞与收藏（按页面，票数最多的前 30 页）</h3>
  {#if reactions}
    <p class="muted small">
      全站 {reactions.reactionRows} 条点赞 / 收藏记录，分布在 {reactions.pages} 个地址上。「不同来源」是按登录账号或匿名访客身份数的：
      票数远大于来源数，说明同一页被同一批身份反复刷过。匿名身份只认 IP（换 User-Agent 不再算新的一票）。
    </p>
    <div class="table-wrap">
      <table class="cols-wide">
        <thead>
          <tr>
            <th>页面</th>
            <th>点赞</th>
            <th>收藏</th>
            <th>不同来源</th>
            <th>最近一次</th>
          </tr>
        </thead>
        <tbody>
          {#each reactions.rows as r (r.slug)}
            <tr>
              <td class="small">
                {titles[r.slug] ?? '—'}
                <span class="muted mono"> {r.slug}</span>
              </td>
              <td>{r.likes}</td>
              <td>{r.stars}</td>
              <td class={r.likes + r.stars > r.actors * 3 + 5 ? 'err' : ''}>{r.actors}</td>
              <td class="small muted">{r.lastAt ? fmtDate(r.lastAt) : '—'}</td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">还没有人点过赞或收藏。</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="muted small">读取中…</p>
  {/if}
</section>

<style>
  .head {
    margin-bottom: 0.6rem;
  }
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    word-break: break-all;
  }
  .small {
    font-size: 0.76rem;
  }
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 0.6rem;
    margin-bottom: 0.8rem;
  }
  .kpi {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.8rem 0.9rem;
  }
  .kpi.plain {
    background: transparent;
    border-style: dashed;
  }
  .kpi .v {
    font-size: 1.5rem;
    font-weight: 700;
  }
  .kpi .l {
    font-size: 0.78rem;
  }
  .ipnote {
    margin: -0.2rem 0 0.8rem;
  }
  .ipnote code {
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0 0.25rem;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0.8rem;
    margin-top: 0.8rem;
    align-items: start;
  }
  .biz {
    margin-top: 0.8rem;
  }
  table {
    font-size: 0.85rem;
  }
  .path {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td {
    padding: 0.32rem 0.4rem;
  }
  .num {
    text-align: right;
    color: var(--muted);
    white-space: nowrap;
  }
  .bar {
    display: grid;
    grid-template-columns: 74px 1fr 38px;
    align-items: center;
    gap: 0.5rem;
    padding: 0.22rem 0;
    font-size: 0.82rem;
  }
  .track {
    height: 8px;
    border-radius: 999px;
    background: #f0f1f3;
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .bn {
    text-align: right;
    color: var(--muted);
  }
</style>
