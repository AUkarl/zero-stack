<script lang="ts">
  import { CAP, LIMIT, type ApplyRow, type ApplySection } from './types';

  let { apply }: { apply: ApplySection } = $props();

  let warning = $state('');

  /* ---------------- 友链要求：引导语 + 条目 ---------------- */

  function addReq() {
    if (apply.requirements.length >= CAP.requirements) {
      warning = `友链要求最多 ${CAP.requirements} 条（与后端限制一致）`;
      return;
    }
    warning = '';
    apply.requirements = [...apply.requirements, ''];
  }

  function removeReq(i: number) {
    const t = apply.requirements[i] ?? '';
    const brief = t.length > 24 ? `${t.slice(0, 24)}…` : t || '（空白）';
    if (!confirm(`删除友链要求第 ${i + 1} 条？${brief}`)) return;
    warning = '';
    apply.requirements = apply.requirements.filter((_, x) => x !== i);
  }

  function moveReq(i: number, dir: -1 | 1) {
    const arr = [...apply.requirements];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    apply.requirements = arr;
  }

  /* ---------------- 我的信息 / 提交示例：标签 + 内容 行 ---------------- */

  type RowField = 'myInfo' | 'submitExample';
  const ROW_LABEL: Record<RowField, string> = { myInfo: '我的信息', submitExample: '提交示例' };
  const ROW_FIELDS: RowField[] = ['myInfo', 'submitExample'];

  function addRow(field: RowField) {
    if (apply[field].length >= CAP.infoRow) {
      warning = `${ROW_LABEL[field]}最多 ${CAP.infoRow} 行（与后端限制一致）`;
      return;
    }
    warning = '';
    /** 新建行沿用上一行的标签：同一块里大多是一整套 名称/链接/头像 */
    const last = apply[field][apply[field].length - 1];
    apply[field] = [...apply[field], { label: last?.label ?? '', value: '' }];
  }

  function removeRow(field: RowField, i: number) {
    const r = apply[field][i];
    if (!confirm(`删除${ROW_LABEL[field]}第 ${i + 1} 行？${r.label || r.value ? `${r.label}：${r.value}` : '（空白）'}`)) return;
    warning = '';
    apply[field] = apply[field].filter((_, x) => x !== i);
  }

  function moveRow(field: RowField, i: number, dir: -1 | 1) {
    const arr = [...apply[field]];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    apply[field] = arr;
  }

  /** 前台「复制」按钮取的就是这一块的纯文本：一行一条，标签后面跟全角冒号 */
  const rowsText = (list: ApplyRow[]): string =>
    list
      .map((r) => ({ label: r.label.trim(), value: r.value.trim() }))
      .filter((r) => r.label || r.value)
      .map((r) => (r.label ? `${r.label}：${r.value}` : r.value))
      .join('\n');

  const reqCount = $derived(apply.requirements.filter((x) => x.trim()).length);
</script>

<section class="card blk">
  <h3>这三块写在哪里</h3>
  <p class="muted small">
    保存写进站点 <code>data/apply.json</code>，主题按「data 优先、页面正文兜底」渲染：
    这里填了任何一段，前台「申请友链」就整栏用下面的内容；三段全空（或删掉那份文件）时，
    才回落到 <code>content/links/_index.md</code> 里手写的 <code>.apply-col</code>。
    名单本身（左邻右舍 / 站点联盟）不在这一页，那是「友链」页维护的 <code>data/links.yaml</code>。
  </p>
</section>

<section class="card blk">
  <div class="row spread">
    <div>
      <h3>友链要求</h3>
      <p class="muted small">引导语一段 + 条目若干，前台排成有序列表（1. 2. 3.）。条目最多 {CAP.requirements} 条，空白条目保存时自动丢掉。</p>
      <p class="muted small">引导语与条目都支持 Markdown 与站内短链：<code>[文字](https://…)</code>、<code>[[文章标识符]]</code>。</p>
    </div>
    <button class="sm primary" onclick={addReq} disabled={apply.requirements.length >= CAP.requirements}>＋ 添加一条</button>
  </div>
  {#if warning}
    <p class="err" role="alert">{warning}</p>
  {/if}
  <label>
    引导语（写在标题下方、条目上面）
    <textarea rows="2" bind:value={apply.intro} maxlength={LIMIT.long} placeholder="若你愿与这片自留地建立链接，请先确认符合以下要求："></textarea>
    <span class="muted small cnt">{apply.intro.length}/{LIMIT.long} 字</span>
  </label>
  {#if !apply.requirements.length}
    <p class="muted small">还没有条目。</p>
  {/if}
  {#each apply.requirements as t, i (i)}
    <div class="para">
      <div class="row spread phead">
        <span class="muted small ord">第 {i + 1} 条 · {t.length} 字{t.trim() ? '' : '（空白，保存时会被丢掉）'}</span>
        <div class="row ops">
          <button class="sm" onclick={() => moveReq(i, -1)} disabled={i === 0} title="上移">↑</button>
          <button class="sm" onclick={() => moveReq(i, 1)} disabled={i === apply.requirements.length - 1} title="下移">↓</button>
          <button class="sm danger" onclick={() => removeReq(i)}>删除</button>
        </div>
      </div>
      <textarea rows="2" bind:value={apply.requirements[i]} maxlength={LIMIT.long} placeholder="建站时间不少于半年，网站访问稳定。" class:over={t.length > LIMIT.long - 200}></textarea>
    </div>
  {/each}
</section>

{#each ROW_FIELDS as field (field)}
  {@const list = apply[field]}
  {@const text = rowsText(list)}
  <section class="card blk">
    <div class="row spread">
      <div>
        <h3>{ROW_LABEL[field]}</h3>
        <p class="muted small">
          一行一条「标签 + 内容」，前台一行显示一条、卡片右上角带「复制」按钮，
          <strong>复制到剪贴板的就是下面预览那几行</strong>。行最多 {CAP.infoRow} 行，标签和内容都空的行保存时自动丢掉。
        </p>
      </div>
      <button class="sm primary" onclick={() => addRow(field)} disabled={list.length >= CAP.infoRow}>＋ 添加一行</button>
    </div>
    {#if !list.length}
      <p class="muted small">还没有行 —— 这一块在前台不会出现。</p>
    {/if}
    {#each list as r, i (r)}
      <div class="ctc">
        <div class="row spread chead">
          <span class="muted small ord">第 {i + 1} 行</span>
          <div class="row ops">
            <button class="sm" onclick={() => moveRow(field, i, -1)} disabled={i === 0} title="上移">↑</button>
            <button class="sm" onclick={() => moveRow(field, i, 1)} disabled={i === list.length - 1} title="下移">↓</button>
            <button class="sm danger" onclick={() => removeRow(field, i)}>删除</button>
          </div>
        </div>
        <div class="grid">
          <label>
            标签
            <input bind:value={r.label} maxlength={LIMIT.short} placeholder="名称" />
          </label>
          <label>
            内容
            <input bind:value={r.value} maxlength={LIMIT.short} placeholder={field === 'myInfo' ? '示例站点，或 https://example.com/home/' : '你的网站名称'} />
          </label>
        </div>
      </div>
    {/each}
    <div class="pv">
      <span class="muted small">复制出来的内容：</span>
      {#if text}
        <pre class="pvtext">{text}</pre>
      {:else}
        <span class="muted small">（还没有有效内容，这一块不会出现）</span>
      {/if}
    </div>
  </section>
{/each}

<p class="muted small note">
  三个小标题（友链要求 / 我的信息 / 提交示例）和「复制」按钮是主题固定写的，不在这一页改；
  「申请友链」这一栏开不开、在线表单收不收，在「设置 → 友情链接」。当前有效条目：{reqCount} 条。
</p>

<style>
  .blk {
    margin-bottom: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .blk h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 0.55rem 0.8rem;
  }
  .cnt {
    font-size: 0.72rem;
  }
  .para,
  .ctc {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .phead,
  .chead {
    align-items: center;
  }
  .ord {
    font-size: 0.74rem;
  }
  .ops {
    flex: none;
    white-space: nowrap;
    gap: 0.3rem;
  }
  textarea {
    width: 100%;
    font-size: 0.88rem;
    line-height: 1.6;
  }
  textarea.over {
    border-color: var(--warn);
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
    margin: 0;
    font-family: inherit;
    font-size: 0.86rem;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .note {
    margin-top: 0.2rem;
  }
</style>
