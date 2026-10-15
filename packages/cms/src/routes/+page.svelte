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
  let content = $state<{ comments: number; subscribers: number; users: number; articles?: number } | null>(null);
  let trend = $state<{ day: string; views: number; visitors: number }[]>([]);
  let devices = $state<Record<string, { k: string; n: number }[]>>({});
  let top = $state<{ site?: string; pages: { path: string; views: number }[]; referrers: { referrer: string; views: number }[] }>({
    pages: [],
    referrers: [],
  });
  let health = $state<any>(null);
  let error = $state('');
  let loading = $state(true);

  async function loadAll() {
    loading = true;
    error = '';
    try {
      const [s, st, tr, dv, tp, hd] = await Promise.all([
        get<{ data: Summary }>('/api/analytics/summary'),
        get<{ data: any }>('/api/admin/stats'),
        get<{ data: { day: string; views: number; visitors: number }[] }>('/api/analytics/trend?days=30'),
        get<{ data: Record<string, { k: string; n: number }[]> }>('/api/analytics/devices'),
        get<{ data: any }>('/api/analytics/top'),
        get<{ data: any }>('/api/admin/health-detail'),
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
      try {
        const cs = await get<{ data: { entries: { name: string; type: string }[]; error?: string } }>('/api/admin/stats/content');
        if (content) content.articles = cs.data.entries.filter((e) => e.type === 'file' && e.name.endsWith('.md')).length;
      } catch {}
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
    ['文章', content?.articles, 'Git 内容目录 .md'],
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

  <div class="card wide">
    <div class="row spread">
      <h3>运行状况</h3>
      {#if health}<span class="muted">API 延迟 {health.checks?.apiLatencyMs}ms</span>{/if}
    </div>
    {#if health}
      <div class="health">
        {#each Object.entries(health.checks ?? {}) as [k, raw] (k)}
          {#if k !== 'apiLatencyMs' && k !== 'cron' && k !== 'email'}
            {@const chk = raw as any}
            <span class="pill" class:good={chk.ok} class:bad={!chk.ok} title={chk.detail ?? ''}>
              {{ d1: 'D1', r2: 'R2', kv: 'KV', emailQueue: '队列', secret: '密钥', md5: 'MD5' }[k] ?? k}{#if chk.detail} · {chk.detail}{/if}
            </span>
          {/if}
        {/each}
        <span class="pill" class:good={health.checks?.email?.secretConfigured} class:bad={!health.checks?.email?.secretConfigured}>
          邮件 · {health.checks?.email?.provider ?? 'smtp'}{#if health.checks?.email?.host} · {health.checks.email.host}{/if}
        </span>
      </div>
      {#if health.checks?.cron?.length}
        <div class="table-wrap">
          <table class="jobs">
            <thead><tr><th>定时任务</th><th>状态</th><th>开始</th><th>摘要</th></tr></thead>
            <tbody>
              {#each health.checks.cron as j (j.name + j.startedAt)}
                <tr>
                  <td>{j.name}</td>
                  <td><span class="badge" class:good={j.status === 'ok'} class:bad={j.status === 'error'}>{j.status}</span></td>
                  <td class="muted">{new Date(j.startedAt * 1000).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td class="muted">{j.detail ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="muted">定时任务尚未执行过（Cron 每天 02:00 UTC 运行，或在设置页手动触发）。</p>
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
