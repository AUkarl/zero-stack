<script lang="ts">
  let { rows = [] }: { rows: { k: string; n: number }[] } = $props();

  const COLORS = ['#2563eb', '#f59e0b', '#16a34a', '#a855f7', '#ef4444', '#94a3b8'];

  const data = $derived.by(() => {
    const grouped = new Map<string, number>();
    for (const r of rows) {
      const raw = String(r.k || '未知').trim() || '未知';
      const key = raw.toLowerCase() === 'other' ? '其他' : raw;
      grouped.set(key, (grouped.get(key) ?? 0) + Math.max(0, Number(r.n) || 0));
    }
    const all = [...grouped.entries()]
      .map(([k, n]) => ({ k, n }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    if (!all.length) return { segments: [] as { k: string; n: number }[], total: 0 };
    const other = all.find((x) => x.k === '其他')?.n ?? 0;
    const named = all.filter((x) => x.k !== '其他');
    const top = named.slice(0, 5);
    const rest = named.slice(5).reduce((a, b) => a + b.n, 0) + other;
    const segments = rest > 0 ? [...top, { k: '其他', n: rest }] : top;
    return { segments, total: segments.reduce((a, b) => a + b.n, 0) };
  });

  const gradient = $derived.by(() => {
    const segs = data.segments;
    if (!segs.length) return '';
    let acc = 0;
    const parts = segs.map((s, i) => {
      const from = (acc / data.total) * 360;
      acc += s.n;
      const to = (acc / data.total) * 360;
      return `${COLORS[i % COLORS.length]} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`;
    });
    return `conic-gradient(${parts.join(', ')})`;
  });

  const pct = (n: number) => (data.total ? Math.round((n / data.total) * 100) : 0);
</script>

{#if !data.segments.length}
  <p class="muted empty">暂无数据</p>
{:else}
  <div class="pie-wrap">
    <div class="pie" style="background:{gradient}">
      <span class="center"><b>{data.total}</b><small>次</small></span>
    </div>
    <ul class="legend">
      {#each data.segments as s, i (s.k)}
        <li>
          <i style="background:{COLORS[i % COLORS.length]}"></i>
          <span class="k" title={s.k}>{s.k}</span>
          <span class="n">{s.n}</span>
          <span class="p">{pct(s.n)}%</span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .pie-wrap {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
  }
  .pie {
    position: relative;
    flex: 0 0 132px;
    width: 132px;
    height: 132px;
    border-radius: 50%;
  }
  .pie::after {
    content: '';
    position: absolute;
    inset: 26px;
    border-radius: 50%;
    background: var(--panel);
  }
  .center {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1.1;
  }
  .center b {
    font-size: 1.1rem;
  }
  .center small {
    font-size: 0.68rem;
    color: var(--muted);
  }
  .legend {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    font-size: 0.8rem;
  }
  .legend li {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) auto auto;
    gap: 0.35rem;
    align-items: center;
  }
  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .legend .k {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .legend .n {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .legend .p {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    min-width: 2.2em;
    text-align: right;
  }
  .empty {
    margin: 0.4rem 0;
    font-size: 0.82rem;
  }
  @media (max-width: 1100px) {
    .pie-wrap {
      gap: 0.7rem;
    }
    .pie {
      flex-basis: 112px;
      width: 112px;
      height: 112px;
    }
    .pie::after {
      inset: 22px;
    }
  }
</style>
