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
    copyrightText
    <input bind:value={footer.copyrightText} maxlength={LIMIT.short} placeholder="2025-{'{year}'} 你的站点名" />
    <span class="muted small">
      写 <code>{'{year}'}</code> 会被主题换成当前年份（今年就是 {nowYear}）；整段留空则前台不显示版权行。{LIMIT.short} 字上限。
    </span>
  </label>
  <div class="pv">
    <span class="muted small">前台效果：</span>
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
    <span class="muted small">预览：</span>
    {#if !footer.showPoweredBy}
      <span class="muted small">（开关关着，这一行不显示）</span>
    {:else if !footer.poweredByText.trim()}
      <span class="muted small">（文字为空，这一行也不显示）</span>
    {:else if footer.poweredByLink.trim()}
      <span class="pvtext">{footer.poweredByText.trim()} ↗</span>
      <span class="muted small url">{footer.poweredByLink.trim()}</span>
    {:else}
      <span class="pvtext">{footer.poweredByText.trim()}</span>
    {/if}
  </div>
</section>

<section class="card blk ro">
  <h3>「designed by …」一行（只读）</h3>
  <p class="roval">designed by 知止</p>
  <p class="muted small">
    这一行不在本页可编辑范围：主题只从 params.toml 的 <code>[footer] designer_text</code> 读它，
    保存 <code>data/footer.json</code> 不会影响它。要改就得改 params.toml（后台的「站点设置 → 开启前端参数写回」
    那条 TOML 通道由站点仓库决定），或者在主题里换默认值。
  </p>
</section>

<section class="card blk">
  <div class="row spread">
    <h3>备案条目（icpItems）</h3>
    <button class="sm primary" onclick={addIcp} disabled={footer.icpItems.length >= CAP.icp}>＋ 添加一条</button>
  </div>
  {#if warning}
    <p class="err" role="alert">{warning}</p>
  {/if}
  <p class="muted small">
    多条会自动排成一行、条目之间加竖线分隔；文字留空的条目保存时会被丢掉（主题本来也不显示它）。最多 {CAP.icp} 条。
  </p>
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
    <p class="muted small">还没有备案条目。</p>
  {/each}
</section>

{#if footer.services.length || footer.socialRow1.length || footer.socialRow2.length}
    <p class="muted small note">
      下面三组图标写进 <code>data/footer.json</code>，优先级高于 params.toml 的
      <code>[[footer.services]]</code> / <code>social_row1</code> / <code>social_row2</code>；
      三组都清空时主题仍会回落到 params.toml 里的那套。地址留空的条目主题不会渲染（免得出现点了没反应的图标）。
      名称是必填的 —— 它同时是这条链接给读屏软件的唯一可读名，只挂图不写名字，读屏用户听到的就只有「链接」两个字。
    </p>
  {/if}

<section class="card blk">
  <h3>「支持服务」那一排</h3>
  <label class="switch">
    <input type="checkbox" bind:checked={footer.showServiceName} />
    <span>默认在图标旁边显示名称（单条想例外，就在下面那条上选「显示 / 只留图标」）</span>
  </label>
</section>

<FooterIconList
  title="支持服务图标（services）"
  hint="页脚中栏的一排图标，站点联盟、打赏之类的入口。名称必填、地址必填；名称显示方式可以整排统一，也可以逐条覆盖。"
  bind:items={footer.services}
/>

<FooterIconList
  title="社交链接 第一排（socialRow1）"
  hint="页脚右栏上面那排。站内地址（如 /index.xml）也可以填，会自动当普通链接打开。"
  bind:items={footer.socialRow1}
/>

<FooterIconList
  title="社交链接 第二排（socialRow2）"
  hint="页脚右栏下面那排。两排都为空时右栏只剩回到顶部按钮。"
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
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
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
  .ro .roval {
    margin: 0;
    font-size: 0.9rem;
    background: #f3f4f6;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    color: var(--muted);
  }
  .icp {
    display: grid;
    grid-template-columns: 1.6rem minmax(180px, 1fr) minmax(200px, 1.4fr) auto;
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
  }
  .note {
    margin-top: 0.2rem;
  }
</style>
