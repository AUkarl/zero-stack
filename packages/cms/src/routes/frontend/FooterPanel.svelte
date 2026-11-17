<script lang="ts">
  import { CAP, LIMIT, type FooterSection } from './types';
  import FooterIconList from './FooterIconList.svelte';

  let { footer }: { footer: FooterSection } = $props();

  let warning = $state('');
  const nowYear = new Date().getFullYear();

  /** {year} 由主题在渲染时替换成当前年份，这里只做同样的替换给管理员看一眼效果 */
  const copyrightPreview = $derived(footer.copyrightText.replaceAll('{year}', String(nowYear)) || '（空：前台就不显示版权这一行）');

  function addIcp() {
    if (footer.icpItems.length >= CAP.icp) {
      warning = `备案条目最多 ${CAP.icp} 条（与后端限制一致）`;
      return;
    }
    warning = '';
    footer.icpItems = [...footer.icpItems, { text: '', link: '' }];
  }

  function removeIcp(i: number) {
    const it = footer.icpItems[i];
    if (!confirm(`删除备案条目「${it.text || it.link || '（空白）'}」？`)) return;
    warning = '';
    footer.icpItems = footer.icpItems.filter((_, x) => x !== i);
  }

  function moveIcp(i: number, dir: -1 | 1) {
    const arr = [...footer.icpItems];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    footer.icpItems = arr;
  }
</script>

<section class="card blk">
  <h3>版权文字</h3>
  <label>
    版权文字
    <input bind:value={footer.copyrightText} maxlength={LIMIT.short} placeholder="2025-{'{year}'} 你的站点名" />
  </label>
  <div class="pv">
    <span class="pvtext">©{copyrightPreview}</span>
  </div>
</section>

<section class="card blk">
  <h3>powered by 行</h3>
  <label class="switch">
    <input type="checkbox" bind:checked={footer.showPoweredBy} />
    <span>显示 powered by 这一行</span>
  </label>
  <div class="grid">
    <label>
      文字
      <input bind:value={footer.poweredByText} maxlength={LIMIT.short} placeholder="以常数为名，收藏无常的瞬间" />
    </label>
    <label>
      链接（留空就是纯文字）
      <input bind:value={footer.poweredByLink} maxlength={LIMIT.href} placeholder="https://example.com" />
    </label>
  </div>
  <div class="pv">
    {#if !footer.showPoweredBy}
      <span class="muted small">（不显示）</span>
    {:else if !footer.poweredByText.trim()}
      <span class="muted small">（不显示）</span>
    {:else if footer.poweredByLink.trim()}
      <span class="pvtext">{footer.poweredByText.trim()} ↗</span>
      <span class="muted small url">{footer.poweredByLink.trim()}</span>
    {:else}
      <span class="pvtext">{footer.poweredByText.trim()}</span>
    {/if}
  </div>
</section>

<section class="card blk">
  <div class="row spread">
    <h3>备案条目</h3>
    <button class="sm primary" onclick={addIcp} disabled={footer.icpItems.length >= CAP.icp}>＋ 添加一条</button>
  </div>
  {#if warning}
    <p class="err" role="alert">{warning}</p>
  {/if}
  {#each footer.icpItems as x, i (x)}
    <div class="icp">
      <span class="ord">{i + 1}</span>
      <label class="tx">
        备案号
        <input bind:value={x.text} maxlength={LIMIT.short} placeholder="吾ICP备 60221023号" />
      </label>
      <label class="lk">
        链接（留空 = 纯文字）
        <input bind:value={x.link} maxlength={LIMIT.href} placeholder="https://beian.miit.gov.cn/" />
      </label>
      <div class="row ops">
        <button class="sm" onclick={() => moveIcp(i, -1)} disabled={i === 0} title="上移">↑</button>
        <button class="sm" onclick={() => moveIcp(i, 1)} disabled={i === footer.icpItems.length - 1} title="下移">↓</button>
        <button class="sm danger" onclick={() => removeIcp(i)}>删除</button>
      </div>
    </div>
  {:else}
    <p class="muted small">暂无。</p>
  {/each}
</section>

<section class="card blk">
  <h3>「支持服务」那一排</h3>
  <label class="switch">
    <input type="checkbox" bind:checked={footer.showServiceName} />
    <span>默认显示名称</span>
  </label>
</section>

<FooterIconList
  title="支持服务图标（services）"
  hint="页脚中栏图标；名称与地址必填。"
  bind:items={footer.services}
/>

<FooterIconList
  title="社交链接 第一排（socialRow1）"
  hint="页脚右栏上排。"
  bind:items={footer.socialRow1}
/>

<FooterIconList
  title="社交链接 第二排（socialRow2）"
  hint="页脚右栏下排。"
  bind:items={footer.socialRow2}
/>

<style>
  .blk {
    margin-bottom: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .blk h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .grid {
    display: grid;
    grid-template-columns: var(--t-4);
    gap: 0.55rem 0.8rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.88rem;
    color: var(--fg);
  }
  .pv {
    border-top: 1px dashed var(--border);
    padding-top: 0.45rem;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .pvtext {
    font-size: 0.9rem;
  }
  .url {
    font-size: 0.74rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
  }
  .icp {
    display: grid;
    /* 两格的最小宽度按「侧栏展开时最窄的主区」定：781px 视口下卡片内宽只剩 469px，
       以前写 180/200 时 834 竖屏就顶破卡片 16px（站主第 10 条）。 */
    grid-template-columns: 1.6rem minmax(130px, 1fr) minmax(140px, 1.2fr) auto;
    gap: 0.5rem;
    align-items: end;
    border-top: 1px solid var(--border);
    padding: 0.45rem 0;
  }
  .ord {
    font-size: 0.76rem;
    color: var(--muted);
    padding-bottom: 0.5rem;
  }
  /* 窄屏：两个输入框上下排，按钮列留在右侧 */
  @media (max-width: 700px) {
    .icp {
      grid-template-columns: 1.6rem minmax(0, 1fr) auto;
    }
    .icp .tx,
    .icp .lk {
      grid-column: 2;
    }
    .icp .ops {
      grid-column: 3;
      grid-row: 1 / span 2;
      align-self: end;
    }
  }
  .ops {
    flex: none;
    white-space: nowrap;
    flex-wrap: nowrap;
  }
  .note {
    margin-top: 0.2rem;
  }
</style>
