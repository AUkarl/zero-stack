<script lang="ts">
  let {
    series,
    labels,
    height = 160,
  }: {
    series: { name: string; color: string; values: number[] }[];
    labels: string[];
    height?: number;
  } = $props();

  const W = 600;
  const H = $derived(height);
  const PAD = { l: 34, r: 8, t: 10, b: 20 };

  const max = $derived(Math.max(1, ...series.flatMap((s) => s.values)));
  const n = $derived(labels.length);

  function pts(values: number[]): string {
    if (n === 0) return '';
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    return values
      .map((v, i) => {
        const x = PAD.l + (iw * i) / Math.max(1, n - 1);
        const y = PAD.t + ih - (ih * v) / max;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  const gridYs = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => PAD.t + (H - PAD.t - PAD.b) * f));
  const tickIdx = $derived(n > 1 ? [0, Math.floor((n - 1) / 4), Math.floor((n - 1) / 2), Math.floor(((n - 1) * 3) / 4), n - 1] : [0]);
</script>

<div class="lc">
  <div class="legend">
    {#each series as s (s.name)}
      <span><i style="background:{s.color}"></i>{s.name}</span>
    {/each}
    <span class="muted max">峰值 {max}</span>
  </div>
  <svg viewBox="0 0 {W} {H}" role="img" preserveAspectRatio="none">
    {#each gridYs as y}
      <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="var(--border)" />
    {/each}
    <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="var(--border-strong)" />
    {#each series as s (s.name)}
      <polyline points={pts(s.values)} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" />
      {#if s.values.length === n && n > 0}
        <circle
          cx={PAD.l + ((W - PAD.l - PAD.r) * (n - 1)) / Math.max(1, n - 1)}
          cy={PAD.t + (H - PAD.t - PAD.b) - ((H - PAD.t - PAD.b) * s.values[n - 1]) / max}
          r="3.2"
          fill={s.color}
        />
      {/if}
    {/each}
    {#each tickIdx as i}
      <text x={PAD.l + ((W - PAD.l - PAD.r) * i) / Math.max(1, n - 1)} y={H - 5} font-size="10" fill="var(--muted)" text-anchor="middle">
        {labels[i]?.slice(5) ?? ''}
      </text>
    {/each}
  </svg>
</div>

<style>
  .lc svg {
    width: 100%;
    display: block;
  }
  .legend {
    display: flex;
    gap: 1rem;
    font-size: 0.8rem;
    color: var(--muted);
    margin-bottom: 0.4rem;
    align-items: center;
  }
  .legend i {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    margin-right: 4px;
  }
  .max {
    margin-left: auto;
  }
</style>
