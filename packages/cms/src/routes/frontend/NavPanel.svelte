<script lang="ts">
  import MediaPicker from '../content/MediaPicker.svelte';
  import { blankNavItem, renumberWeights, CAP, LIMIT, type NavItem, type NavSection } from './types';

  let { nav }: { nav: NavSection } = $props();

  const POSITION_LABEL: Record<'' | 'controls', string> = { '': '主菜单', controls: '右侧图标区' };

  let warning = $state('');

  /** 已填过的标识 → 它出现在第几项（父项下拉与校验都用这份） */
  const idOwners = $derived.by(() => {
    const m = new Map<string, number>();
    nav.items.forEach((it, i) => {
      const id = it.identifier.trim();
      if (id && !m.has(id)) m.set(id, i);
    });
    return m;
  });

  /** 每个标识挂了多少个子项 */
  const childCount = $derived.by(() => {
    const m = new Map<string, number>();
    for (const it of nav.items) {
      const p = it.parent.trim();
      if (p) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  });

  /** 区域内的序号（1 起），让「上移下移」的效果一眼看到 */
  function orderIn(group: '' | 'controls', idx: number): number {
    let n = 0;
    for (let i = 0; i <= idx; i++) if (nav.items[i].position === group) n++;
    return n;
  }

  /** 父项下拉候选：同区域、本身是顶级项的标识；当前值不在候选里也补一条，免得下拉把已填的值吞掉 */
  function parentOptions(item: NavItem): { value: string; label: string }[] {
    const list: { value: string; label: string }[] = [{ value: '', label: '（顶级菜单项）' }];
    const seen = new Set<string>();
    nav.items.forEach((p) => {
      const id = p.identifier.trim();
      if (!id || seen.has(id)) return;
      if (p === item || p.parent.trim() || p.position !== item.position) return;
      seen.add(id);
      list.push({ value: id, label: `└ ${p.name || '（未命名）'}（identifier=${id}）` });
    });
    const cur = item.parent.trim();
    if (cur && !seen.has(cur)) list.push({ value: item.parent, label: `⚠ ${cur}（本段里没有这个标识，需修正）` });
    return list;
  }

  function addItem() {
    if (nav.items.length >= CAP.nav) {
      warning = `导航栏最多 ${CAP.nav} 项（与后端限制一致），已经到顶了`;
      return;
    }
    const next = nav.items.filter((x) => x.position === '').length + 1;
    warning = '';
    nav.items = [...nav.items, { ...blankNavItem(), name: '', url: '', weight: next }];
  }

  function duplicate(i: number) {
    if (nav.items.length >= CAP.nav) {
      warning = `导航栏最多 ${CAP.nav} 项，先删掉不用的再复制`;
      return;
    }
    const src = nav.items[i];
    warning = '';
    nav.items = [...nav.items.slice(0, i + 1), { ...src, identifier: '', parent: src.parent, name: `${src.name} 副本` }, ...nav.items.slice(i + 1)];
  }

  function removeItem(i: number) {
    const it = nav.items[i];
    const kids = it.identifier.trim() ? (childCount.get(it.identifier.trim()) ?? 0) : 0;
    const tip = kids ? `它还是 ${kids} 个子项的父项，删掉后那些子项会挂不上（要一起删或改 parent）。` : '';
    if (!confirm(`删除导航项「${it.name || '未命名'}」？${tip}`)) return;
    warning = '';
    nav.items = nav.items.filter((_, x) => x !== i);
  }

  /** 同区域内上下移动：先换位，再把该区域的 weight 重排成 1、2、3… */
  function move(i: number, dir: -1 | 1) {
    const arr = [...nav.items];
    const group = arr[i].position;
    let j = i + dir;
    while (j >= 0 && j < arr.length && arr[j].position !== group) j += dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    nav.items = renumberWeights(arr, group);
    warning = '';
  }

  /* 图片字段可以直接从媒体库挑 */
  let pickerOpen = $state(false);
  let pickerIdx = $state(-1);
  function openPicker(i: number) {
    pickerIdx = i;
    pickerOpen = true;
  }
  function onPick(url: string) {
    const it = pickerIdx >= 0 ? nav.items[pickerIdx] : null;
    if (it) it.image = url;
    pickerOpen = false;
  }

  /* ---------------- 前台顺序预览 ---------------- */

  interface Node {
    item: NavItem;
    idx: number;
    kids: Node[];
  }  interface Preview {
    group: '' | 'controls';
    tops: Node[];
    orphans: Node[];
  }

  const preview = $derived.by<Preview[]>(() => {
    const groups: ('' | 'controls')[] = ['', 'controls'];
    return groups.map((group) => {
      const inGroup = nav.items.map((item, idx) => ({ item, idx })).filter((x) => x.item.position === group);
      const byWeight = (a: { item: NavItem; idx: number }, b: { item: NavItem; idx: number }) =>
        a.item.weight - b.item.weight || a.idx - b.idx;
      const tops = inGroup.filter((x) => !x.item.parent.trim()).sort(byWeight);
      const topIds = new Set(tops.map((t) => t.item.identifier.trim()).filter(Boolean));
      const kidsOf = new Map<string, { item: NavItem; idx: number }[]>();
      const placed = new Set<number>(tops.map((t) => t.idx));
      for (const x of inGroup) {
        const p = x.item.parent.trim();
        if (!p || !topIds.has(p)) continue;
        kidsOf.set(p, [...(kidsOf.get(p) ?? []), x]);
        placed.add(x.idx);
      }
      const nodes: Node[] = tops.map((t) => ({
        item: t.item,
        idx: t.idx,
        kids: [...(kidsOf.get(t.item.identifier.trim()) ?? [])]
          .sort(byWeight)
          .map((c) => ({ item: c.item, idx: c.idx, kids: [] as Node[] })),
      }));
      const orphans: Node[] = inGroup.filter((x) => !placed.has(x.idx)).sort(byWeight).map((x) => ({ item: x.item, idx: x.idx, kids: [] }));
      return { group, tops: nodes, orphans };
    });
  });

  const count = $derived(nav.items.length);
</script>

<div class="row spread head">
  <div>
    <h3>导航栏菜单项</h3>
    <p class="muted small tip">
      共 {count} 项（上限 {CAP.nav}）。上面的顺序就是列表顺序，真正的前台顺序由「区域 + weight」决定，右侧预览会实时跟着变。
    </p>
  </div>
  <button class="sm primary" onclick={addItem} disabled={count >= CAP.nav}>＋ 添加菜单项</button>
</div>

{#if warning}
  <p class="err" role="alert">{warning}</p>
{/if}

<div class="legend">
  <span class="chip on">主菜单</span>
  <span class="muted small">站点标题旁边那一排</span>
  <span class="chip on">右侧图标区</span>
  <span class="muted small">和主题自带的图标开关同一排，按 weight 一起排序</span>
</div>

{#each nav.items as it, i (it)}
  {@const kids = it.identifier.trim() ? (childCount.get(it.identifier.trim()) ?? 0) : 0}
  {@const badParent = !!it.parent.trim() && !idOwners.has(it.parent.trim())}
  <section class="card item" class:orphan={badParent}>
    <div class="row spread ih">
      <div class="row hh">
        <strong class="ttl">{it.name || '（未命名）'}</strong>
        <span class="badge">{POSITION_LABEL[it.position]} · 第 {orderIn(it.position, i)} 个</span>
        {#if kids}<span class="badge good">父项：{kids} 个子项</span>{/if}
        {#if it.parent}<span class="badge" class:bad={badParent}>{badParent ? `parent 无效：${it.parent}` : `子项 → ${it.parent}`}</span>{/if}
        {#if it.zeroAccount}<span class="badge pending">账号入口</span>{/if}
      </div>
      <div class="row ops">
        <button class="sm" onclick={() => move(i, -1)} title="在同区域内上移">↑</button>
        <button class="sm" onclick={() => move(i, 1)} title="在同区域内下移">↓</button>
        <button class="sm ghost" onclick={() => duplicate(i)} title="复制一项">复制</button>
        <button class="sm danger" onclick={() => removeItem(i)}>删除</button>
      </div>
    </div>

    <div class="grid">
      <label>
        名称 *
        <input bind:value={it.name} maxlength={LIMIT.short} placeholder="主页" />
        <span class="muted small cnt">{it.name.length}/{LIMIT.short}</span>
      </label>
      <label>
        链接
        <input bind:value={it.url} maxlength={LIMIT.href} placeholder="/home/ 或 https://example.com" />
        <span class="muted small">站内写 / 开头的路径；父项（只有子菜单）可留空</span>
      </label>
      <label>
        区域
        <select bind:value={it.position}>
          <option value="">主菜单</option>
          <option value="controls">右侧图标区</option>
        </select>
        <span class="muted small">换了区域，weight 会在下一次上移 / 下移时按新区重排</span>
      </label>
      <label>
        weight（越小越靠前）
        <input type="number" step="1" bind:value={it.weight} min={LIMIT.weightMin} max={LIMIT.weightMax} />
        <span class="muted small">主题自带的图标开关默认排在 90 和 100，要插到它们中间就填 91 ~ 99</span>
      </label>
      <label>
        标识 identifier
        <input bind:value={it.identifier} maxlength={LIMIT.short} placeholder="有子项时必填，例如 work" />
        <span class="muted small">子项靠 parent 指回这个值</span>
      </label>
      <label>
        父项 parent
        <select bind:value={it.parent}>
          {#each parentOptions(it) as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>
        <span class="muted small">候选只列本区域已填标识的顶级项，避免指向不存在的父项</span>
      </label>
      <label>
        图标（Font Awesome 类名）
        <input bind:value={it.icon} maxlength={LIMIT.short} placeholder="fa-solid fa-house" />
      </label>
      <label>
        图标图片（与图标二选一，优先级更高）
        <div class="row imgrow">
          <input bind:value={it.image} maxlength={LIMIT.href} placeholder="/img/xxx.svg 或完整外链" />
          <button class="sm" onclick={() => openPicker(i)}>媒体库</button>
        </div>
      </label>
    </div>

    <div class="row sw">
      <label class="switch">
        <input type="checkbox" bind:checked={it.iconOnly} />
        <span>只显示图标（名称变成鼠标提示）</span>
      </label>
      <label class="switch">
        <input type="checkbox" bind:checked={it.external} />
        <span>外部链接（新标签打开）</span>
      </label>
      <span class="muted small">
        登录 / 账号入口不在这里配：主题固定补一项，显示与否只看「设置 → 注册与邀请码 → 前台账号系统」
        （历史数据里勾过账号入口的那一项仍然生效，主题不会重复补第二个）。
      </span>
    </div>
    {#if badParent}
      <p class="err small">parent 填的「{it.parent}」在本段里没有任何项的标识与它相同，这一项不会出现在子菜单里。改 parent 或给父项补上 identifier。</p>
    {/if}
  </section>
{:else}
  <section class="card">
    <p class="muted">还没有菜单项。点上面的「＋ 添加菜单项」开始。</p>
  </section>
{/each}

<section class="card prev">
  <h4>前台顺序预览</h4>
  <p class="muted small">按「区域 + weight」算出来的最终顺序；子项缩进在父项下面，⚠ 开头的是挂不上父项的孤立项。</p>
  {#each preview as p (p.group)}
    <div class="pvgrp">
      <h5>{POSITION_LABEL[p.group]}</h5>
      {#if !p.tops.length && !p.orphans.length}
        <p class="muted small">这个区域还没有项。</p>
      {/if}
      <ol class="tree">
        {#each p.tops as t (t.idx)}
          <li>
            <span class="w">{t.item.weight}</span>
            <span class="nm" title={t.item.url || '无链接'}>{t.item.name || '（未命名）'}</span>
            <span class="muted small url">{t.item.url || '（无链接，父项）'}</span>
            {#if t.item.icon}<span class="muted small ic">{t.item.icon}</span>{/if}
            {#if t.item.iconOnly}<span class="badge">仅图标</span>{/if}
            {#if t.kids.length}<span class="muted small">▾ {t.kids.length}</span>{/if}
            {#if t.kids.length}
              <ol class="tree sub">
                {#each t.kids as c (c.idx)}
                  <li>
                    <span class="w">{c.item.weight}</span>
                    <span class="nm" title={c.item.url || '无链接'}>{c.item.name || '（未命名）'}</span>
                    <span class="muted small url">{c.item.url || '（无链接）'}</span>
                  </li>
                {/each}
              </ol>
            {/if}
          </li>
        {/each}
      </ol>
      {#if p.orphans.length}
        <p class="err small">挂不上父项（{p.orphans.length}）：</p>
        <ul class="tree">
          {#each p.orphans as o (o.idx)}
            <li>
              <span class="w">{o.item.weight}</span>
              <span class="nm">{o.item.name || '（未命名）'}</span>
              <span class="muted small url">parent={o.item.parent}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/each}
</section>

<MediaPicker bind:open={pickerOpen} title="选择导航图标图片" onpick={onPick} />

<style>
  .head {
    margin-bottom: 0.6rem;
  }
  .tip {
    margin: 0.2rem 0 0;
  }
  .legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.7rem;
  }
  .legend .chip {
    padding: 0.1rem 0.55rem;
    font-size: 0.74rem;
    border-radius: 999px;
  }
  .legend .chip.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .item {
    margin-bottom: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .item.orphan {
    border-color: #fecaca;
  }
  .ih {
    align-items: center;
    gap: 0.4rem;
  }
  .hh {
    gap: 0.4rem;
    min-width: 0;
  }
  .ttl {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ops {
    flex: none;
    white-space: nowrap;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.55rem 0.8rem;
  }
  .cnt {
    font-size: 0.7rem;
  }
  .imgrow input {
    flex: 1;
    min-width: 0;
  }
  .sw {
    gap: 0.9rem;
    border-top: 1px dashed var(--border);
    padding-top: 0.5rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.84rem;
    color: var(--fg);
  }
  .prev {
    margin-top: 0.9rem;
  }
  .prev h4 {
    margin: 0 0 0.2rem;
    font-size: 0.95rem;
  }
  .pvgrp {
    margin-top: 0.6rem;
  }
  .pvgrp h5 {
    margin: 0 0 0.25rem;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .tree {
    margin: 0;
    padding-left: 1.1rem;
    font-size: 0.84rem;
    list-style: none;
    padding-inline-start: 0;
  }
  .tree li {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.12rem 0;
  }
  .tree.sub {
    padding-left: 1.1rem;
    border-left: 1px dashed var(--border);
    margin-left: 0.3rem;
  }
  .w {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.74rem;
    color: var(--muted);
    min-width: 2rem;
  }
  .nm {
    font-weight: 600;
  }
  .url,
  .ic {
    font-size: 0.74rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
  }
  .badge.bad {
    background: #fee2e2;
    color: var(--bad);
  }
</style>
