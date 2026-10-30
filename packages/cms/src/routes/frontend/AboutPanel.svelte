<script lang="ts">
  import { CAP, LIMIT, type AboutSection, type ContactItem } from './types';

  let { about }: { about: AboutSection } = $props();

  /** 三个「段落列表」区块共用一套增删改排序 */
  type ParaField = 'bio' | 'site' | 'declaration';
  const PARA_BLOCKS: { field: ParaField; title: string; hint: string }[] = [
    { field: 'bio', title: '关于我（bio）', hint: '一段一个文本框，按顺序显示在「关于我」区' },
    { field: 'site', title: '关于本站（site）', hint: '写站点是怎么来的、用什么做的；一段一框' },
    { field: 'declaration', title: '站点声明（declaration）', hint: '版权许可、隐私与免责声明；一段一框' },
  ];

  const PARA_LABEL: Record<ParaField, string> = { bio: '关于我', site: '关于本站', declaration: '站点声明' };

  function addPara(field: ParaField) {
    if (about[field].length >= CAP.paragraph) return;
    about[field] = [...about[field], ''];
  }

  function removePara(field: ParaField, i: number) {
    const text = about[field][i] ?? '';
    const brief = text.length > 24 ? `${text.slice(0, 24)}…` : text || '（空段落）';
    if (!confirm(`删除「${PARA_LABEL[field]}」第 ${i + 1} 段？${brief}`)) return;
    about[field] = about[field].filter((_, x) => x !== i);
  }

  function movePara(field: ParaField, i: number, dir: -1 | 1) {
    const arr = [...about[field]];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    about[field] = arr;
  }

  /* ---------------- 找到我 ---------------- */

  let contactWarning = $state('');

  function addContact() {
    if (about.contacts.length >= CAP.contacts) {
      contactWarning = `「找到我」最多 ${CAP.contacts} 条（与后端限制一致）`;
      return;
    }
    contactWarning = '';
    const last = about.contacts[about.contacts.length - 1];
    const item: ContactItem = { label: last?.label ?? '', text: '', url: '', external: true };
    about.contacts = [...about.contacts, item];
  }

  function removeContact(i: number) {
    const c = about.contacts[i];
    if (!confirm(`删除「${c.text || c.url || '（空白）'}」这条联系方式？`)) return;
    contactWarning = '';
    about.contacts = about.contacts.filter((_, x) => x !== i);
  }

  function moveContact(i: number, dir: -1 | 1) {
    const arr = [...about.contacts];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    about.contacts = arr;
  }
</script>

<section class="card blk">
  <h3>关于页头部</h3>
  <div class="grid">
    <label>
      描述 desc（标题下方那一行）
      <input bind:value={about.desc} maxlength={LIMIT.short} placeholder="云朵会散，但摩尔永恒" />
      <span class="muted small cnt">{about.desc.length}/{LIMIT.short}</span>
    </label>
    <label>
      个性签名 tagline（显示在名字下方）
      <input bind:value={about.tagline} maxlength={LIMIT.short} placeholder="日上三竿我独眠，谁是神仙，我是神仙" />
      <span class="muted small cnt">{about.tagline.length}/{LIMIT.short}</span>
    </label>
  </div>
  <p class="muted small">
    头像、名字、以及各个区块要不要显示（<code>show_bio</code> / <code>show_site</code> / <code>show_declaration</code> 等开关）
    仍然读 params.toml 的 <code>[about]</code>；这里存的是区块正文本身。
  </p>
  <p class="muted small">支持 Markdown 与 <code>[[文章标识符]]</code> 短链。</p>
</section>

{#each PARA_BLOCKS as b (b.field)}
  {@const list = about[b.field]}
  <section class="card blk">
    <div class="row spread">
      <div>
        <h3>{b.title}</h3>
        <p class="muted small">{b.hint}；每段上限 {LIMIT.long} 字，最多 {CAP.paragraph} 段（空白段保存时会自动丢掉）。</p>
      </div>
      <button class="sm primary" onclick={() => addPara(b.field)} disabled={list.length >= CAP.paragraph}>＋ 添加一段</button>
    </div>
    {#if !list.length}
      <p class="muted small">还没有内容，保存后这一区在前台是空的。</p>
    {/if}
    {#each list as text, i (i)}
      <div class="para">
        <div class="row spread phead">
          <span class="muted small ord">第 {i + 1} 段 · {text.length} 字</span>
          <div class="row ops">
            <button class="sm" onclick={() => movePara(b.field, i, -1)} disabled={i === 0} title="上移">↑</button>
            <button class="sm" onclick={() => movePara(b.field, i, 1)} disabled={i === list.length - 1} title="下移">↓</button>
            <button class="sm danger" onclick={() => removePara(b.field, i)}>删除</button>
          </div>
        </div>
        <textarea
          rows="4"
          bind:value={about[b.field][i]}
          maxlength={LIMIT.long}
          placeholder="一段正文，支持换行"
          class:over={text.length > LIMIT.long - 200}
        ></textarea>
      </div>
    {/each}
  </section>
{/each}

<section class="card blk">
  <div class="row spread">
    <div>
      <h3>找到我（contacts）</h3>
      <p class="muted small">
        相同「分组名」的条目会归到同一组下面显示，例如都写 <code>邮件-Email</code>。最多 {CAP.contacts} 条；
        文字和链接都留空的条目保存时会被丢掉。
      </p>
    </div>
    <button class="sm primary" onclick={addContact} disabled={about.contacts.length >= CAP.contacts}>＋ 添加联系方式</button>
  </div>
  {#if contactWarning}
    <p class="err" role="alert">{contactWarning}</p>
  {/if}
  {#if !about.contacts.length}
    <p class="muted small">还没有联系方式。</p>
  {/if}
  {#each about.contacts as c, i (c)}
    <div class="ctc">
      <div class="row spread chead">
        <span class="muted small ord">第 {i + 1} 条</span>
        <div class="row ops">
          <label class="switch">
            <input type="checkbox" bind:checked={c.external} />
            <span>外部链接（新标签打开）</span>
          </label>
          <button class="sm" onclick={() => moveContact(i, -1)} disabled={i === 0} title="上移">↑</button>
          <button class="sm" onclick={() => moveContact(i, 1)} disabled={i === about.contacts.length - 1} title="下移">↓</button>
          <button class="sm danger" onclick={() => removeContact(i)}>删除</button>
        </div>
      </div>
      <div class="grid">
        <label>
          分组名 label
          <input bind:value={c.label} maxlength={LIMIT.short} placeholder="社交-Social Media" />
        </label>
        <label>
          显示文字 text
          <input bind:value={c.text} maxlength={LIMIT.short} placeholder="GitHub" />
        </label>
        <label>
          链接 url
          <input bind:value={c.url} maxlength={LIMIT.href} placeholder="https://github.com/… 或 mailto:x@example.com" />
        </label>
      </div>
    </div>
  {/each}
  <p class="muted small">
    分组标题就用上面填的 label；params.toml 里 <code>[[aboutContacts]]</code> 那个 <code>labelKey</code> 字段本页不编辑，也不用管。
  </p>
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
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.82rem;
    color: var(--fg);
  }
</style>
