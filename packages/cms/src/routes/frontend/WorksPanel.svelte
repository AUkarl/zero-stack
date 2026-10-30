<script lang="ts">
  import { CAP, LIMIT, type WorksSection } from './types';

  let { works }: { works: WorksSection } = $props();

  let warning = $state('');

  function addItem() {
    if (works.items.length >= CAP.works) {
      warning = `工坊项目最多 ${CAP.works} 个（与后端限制一致）`;
      return;
    }
    warning = '';
    works.items = [...works.items, { title: '', desc: '', status: '', url: '' }];
  }

  function removeItem(i: number) {
    const it = works.items[i];
    if (!confirm(`删除工坊项目「${it.title || '（未命名）'}」？保存后前台工坊页就没有这一项了。`)) return;
    warning = '';
    works.items = works.items.filter((_, x) => x !== i);
  }

  function moveItem(i: number, dir: -1 | 1) {
    const arr = [...works.items];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    works.items = arr;
  }
</script>

<section class="card blk">
  <h3>工坊页描述</h3>
  <label>
    desc（标题下方那一行）
    <input bind:value={works.desc} maxlength={LIMIT.short} placeholder="每一朵云都由思想摩尔组成" />
    <span class="muted small cnt">{works.desc.length}/{LIMIT.short}</span>
  </label>
  <p class="muted small">
    工坊页开不开（<code>[work] enable</code>）以及描述显不显示（<code>show_desc</code>）仍然读 params.toml，这里只存正文和项目列表。
    说明与项目描述支持 Markdown 与 <code>[[文章标识符]]</code> 短链。
  </p>
</section>

<section class="card blk">
  <div class="row spread">
    <div>
      <h3>项目列表（items）</h3>
      <p class="muted small">按列表顺序显示；标题必填，链接留空就是不带链接的一项。最多 {CAP.works} 个。</p>
    </div>
    <button class="sm primary" onclick={addItem} disabled={works.items.length >= CAP.works}>＋ 添加项目</button>
  </div>
  {#if warning}
    <p class="err" role="alert">{warning}</p>
  {/if}
  {#if !works.items.length}
    <p class="muted small">还没有项目，保存后前台工坊页是空的。</p>
  {/if}
  {#each works.items as w, i (w)}
    <div class="wid" class:noname={!w.title.trim()}>
      <div class="row spread wh">
        <span class="ttl">{w.title || '（未命名项目）'}</span>
        <div class="row ops">
          <button class="sm" onclick={() => moveItem(i, -1)} disabled={i === 0} title="上移">↑</button>
          <button class="sm" onclick={() => moveItem(i, 1)} disabled={i === works.items.length - 1} title="下移">↓</button>
          <button class="sm danger" onclick={() => removeItem(i)}>删除</button>
        </div>
      </div>
      <div class="grid">
        <label>
          标题 *
          <input bind:value={w.title} maxlength={LIMIT.short} placeholder="Hugo 主题" />
        </label>
        <label>
          状态
          <input bind:value={w.status} maxlength={LIMIT.short} placeholder="已发布 / 维护中 / 草稿" />
        </label>
        <label>
          链接
          <input bind:value={w.url} maxlength={LIMIT.href} placeholder="https://github.com/… 或 /posts/xxx/" />
        </label>
      </div>
      <label>
        简介
        <textarea rows="3" bind:value={w.desc} maxlength={LIMIT.long} placeholder="这个项目是做什么的"></textarea>
        <span class="muted small cnt">{w.desc.length}/{LIMIT.long}</span>
      </label>
      {#if !w.title.trim()}
        <p class="warn small">这一项还没填标题，保存会被拦下来（要么填上，要么删掉）。</p>
      {/if}
    </div>
  {/each}
</section>

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
  .cnt {
    font-size: 0.72rem;
  }
  .wid {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .wid.noname {
    border-color: var(--bad-border);
  }
  .wh {
    align-items: center;
  }
  .ttl {
    font-weight: 650;
    font-size: 0.9rem;
  }
  .ops {
    flex: none;
    white-space: nowrap;
    gap: 0.3rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.5rem 0.8rem;
  }
  .small {
    font-size: 0.76rem;
  }
</style>
