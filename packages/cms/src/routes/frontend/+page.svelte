<script lang="ts">
  import { get, post } from '#lib/api';
  import AboutPanel from './AboutPanel.svelte';
  import FallbackCard from './FallbackCard.svelte';
  import FooterPanel from './FooterPanel.svelte';
  import HomePanel from './HomePanel.svelte';
  import MomentsPanel from './MomentsPanel.svelte';
  import SeoPanel from './SeoPanel.svelte';
  import NavPanel from './NavPanel.svelte';
  import RemovedCard from './RemovedCard.svelte';
  import RepoPanel from './RepoPanel.svelte';
  import SectionBar from './SectionBar.svelte';
  import SitePanel from './SitePanel.svelte';
  import WorksPanel from './WorksPanel.svelte';
  import { notesOf, validateSection } from './validate';
  import {
    CAP,
    LIMIT,
    SECTION_KEYS,
    SECTION_META,
    blankForms,
    clone,
    normalizeSection,
    payloadOf,
    readFrontendData,
    type Forms,
    type Issue,
    type SaveResult,
    type SectionKey,
  } from './types';

  /**
   * 前端管理：基本信息 / 导航栏 / 首页 / 页脚 / 关于页 / 工坊 / 时刻页，七段共用底部一个「保存设置」按钮。
   *
   * 一次 POST /api/admin/frontend 把要提交的几段一起发过去，后端写多个 data/*.json，
   * 但最多只触发一次站点构建 —— 这就是全页只留一个保存按钮的原因。
   * 提交规则：站点上已有文件的段，按当前表单值提交（内容没变就不重复写盘）；
   * 原本没有文件的段，只有点过「从空白开始填写」并且真填了内容才提交，
   * 免得手一抖就用空白内容把 params.toml 的配置盖掉。
   *
   * 最后一个「主题配置文件」子标签是另一条通道：它改的是仓库里的 params.toml 等文本文件，
   * 走自己的读取/保存与 sha 乐观锁，不经过 payloadOf/normalizeSection，也不参与底部那个统一按钮。
   */

  type Pending = 'write' | 'delete' | 'skip';
  /** 七个 data JSON 段 + 仓库源文件段（后者不用 forms/meta，只多一个 tab 值） */
  type TabKey = SectionKey | 'repo';
  interface SecMeta {
    /** 站点 data 目录里已经有这个文件 */
    loaded: boolean;
    /** 已存内容的规范化 JSON，用来判断「有没有改动」 */
    loadedJson: string;
    /** 原本没有文件，管理员点了「从空白开始填写」 */
    initialized: boolean;
    /** 本次保存要删除这个文件 */
    removed: boolean;
  }

  const BLANK = blankForms();
  /** 空白模板的提交值：初始化后一个字都没改 → 不该写盘 */
  const BLANK_JSON: Record<SectionKey, string> = {
    site: JSON.stringify(payloadOf('site', BLANK.site)),
    nav: JSON.stringify(payloadOf('nav', BLANK.nav)),
    home: JSON.stringify(payloadOf('home', BLANK.home)),
    footer: JSON.stringify(payloadOf('footer', BLANK.footer)),
    about: JSON.stringify(payloadOf('about', BLANK.about)),
    works: JSON.stringify(payloadOf('works', BLANK.works)),
    moments: JSON.stringify(payloadOf('moments', BLANK.moments)),
    seo: JSON.stringify(payloadOf('seo', BLANK.seo)),
  };

  /** 子标签角标：class 是运行时拼的会触发 unused-selector，改用行内 style */
  type ChipKind = 'none' | 'good' | 'warn' | 'bad';
  const CHIP_STYLE: Record<ChipKind, string> = {
    none: 'background:var(--accent-soft);color:var(--accent)',
    good: 'background:#dcfce7;color:#15803d',
    warn: 'background:#fef3c7;color:#b45309',
    bad: 'background:#fee2e2;color:#b91c1c',
  };

  const TABS: TabKey[] = [...SECTION_KEYS, 'repo'];

  let forms = $state<Forms>(clone(BLANK));
  let baseline = $state<Forms | null>(null);
  let meta = $state<Record<SectionKey, SecMeta>>(makeMeta());

  let tab = $state<TabKey>('site');
  let dataDir = $state('data');
  let ready = $state(false);
  let loading = $state(false);
  let loadError = $state('');
  let getNotice = $state<string | null>(null);

  let saving = $state(false);
  let triggerBuild = $state(true);
  let issues = $state<Issue[]>([]);
  let saveError = $state('');
  let saveMessage = $state('');
  let saveWritten = $state<string[]>([]);
  let saveNote = $state<string[]>([]);

  function makeMeta(): Record<SectionKey, SecMeta> {
    const m = {} as Record<SectionKey, SecMeta>;
    for (const k of SECTION_KEYS) m[k] = { loaded: false, loadedJson: '', initialized: false, removed: false };
    return m;
  }

  /** 各段类型不一样，联合键直接赋值 TS 要交集；统一走这个写入函数 */
  function setForm(key: SectionKey, value: unknown) {
    (forms as unknown as Record<SectionKey, unknown>)[key] = value;
  }

  const errText = (e: unknown): string => {
    const m = e instanceof Error ? e.message : '请求失败';
    return m === 'AUTH_EXPIRED' ? '登录已过期，请重新登录后台' : m;
  };

  async function load() {
    loading = true;
    loadError = '';
    try {
      const res = await get<{ data: unknown }>('/api/admin/frontend');
      const d = readFrontendData(res.data);
      dataDir = d.dataDir;
      getNotice = d.notice;
      const values: Record<SectionKey, unknown> = {
        site: d.site,
        nav: d.nav,
        home: d.home,
        footer: d.footer,
        about: d.about,
        works: d.works,
        moments: d.moments,
        seo: d.seo,
      };
      const next = {} as Forms;
      const m = makeMeta();
      for (const k of SECTION_KEYS) {
        const raw = values[k];
        const v = raw === null || raw === undefined ? clone(BLANK[k]) : payloadOf(k, normalizeSection(k, raw));
        (next as Record<SectionKey, unknown>)[k] = v;
        m[k] = {
          loaded: raw !== null && raw !== undefined,
          loadedJson: raw === null || raw === undefined ? '' : JSON.stringify(v),
          initialized: false,
          removed: false,
        };
      }
      forms = next;
      baseline = clone(next);
      meta = m;
      ready = true;
      issues = [];
    } catch (e) {
      loadError = errText(e);
    } finally {
      loading = false;
    }
  }

  /** 手动刷新：连上一次保存的结果提示一起清掉（save() 里回读时不走这里，保留后端 message） */
  async function reload() {
    saveMessage = '';
    saveNote = [];
    saveWritten = [];
    saveError = '';
    await load();
  }

  /* ------------------------------------------------------------------ 状态 */

  function pendingOf(key: SectionKey): Pending {
    const m = meta[key];
    if (m.removed) return m.loaded ? 'delete' : 'skip';
    if (!m.loaded && !m.initialized) return 'skip';
    const cur = JSON.stringify(payloadOf(key, forms[key]));
    if (m.loaded && cur === m.loadedJson) return 'skip';
    if (!m.loaded && cur === BLANK_JSON[key]) return 'skip';
    return 'write';
  }

  const pendingMap = $derived.by(() => {
    const m = {} as Record<SectionKey, Pending>;
    for (const k of SECTION_KEYS) m[k] = pendingOf(k);
    return m;
  });

  const pendingKeys = $derived(SECTION_KEYS.filter((k) => pendingMap[k] !== 'skip'));
  const writeKeys = $derived(pendingKeys.filter((k) => pendingMap[k] === 'write'));
  const deleteKeys = $derived(pendingKeys.filter((k) => pendingMap[k] === 'delete'));

  /** 只校验要写入的段；删除段不需要内容合法 */
  const liveIssues = $derived.by(() => {
    const out: Issue[] = [];
    for (const k of writeKeys) out.push(...validateSection(k, forms[k]));
    return out;
  });
  /** 保存失败后固定展示那一刻的错误清单，之后没改动也还在 */
  const shownIssues = $derived(issues.length ? issues : liveIssues);

  function issueCountOf(key: SectionKey): number {
    return shownIssues.filter((x) => x.section === key).length;
  }

  const notesOfActive = $derived(tab !== 'repo' && pendingMap[tab] === 'write' ? notesOf(tab, forms[tab]) : []);

  /** 空白条目会被 payloadOf 丢掉，保存前说一句，免得以为写进去了 */
  const droppedActive = $derived(
    tab !== 'repo' &&
      pendingMap[tab] === 'write' &&
      JSON.stringify(forms[tab]) !== JSON.stringify(payloadOf(tab, forms[tab])),
  );

  function chipText(key: SectionKey): string {
    const n = issueCountOf(key);
    if (n) return `${n} 处错误`;
    const p = pendingMap[key];
    if (p === 'delete') return '将删除';
    if (p === 'write') return meta[key].loaded ? '有改动' : '将写入';
    if (!meta[key].loaded) return meta[key].initialized ? '空白未填' : '用 params';
    return '已配置';
  }

  function chipKind(key: SectionKey): ChipKind {
    if (issueCountOf(key) || pendingMap[key] === 'delete') return 'bad';
    if (pendingMap[key] === 'write') return 'warn';
    if (!meta[key].loaded) return 'none';
    return 'good';
  }

  function tabLabel(t: TabKey): string {
    return t === 'repo' ? '主题配置文件' : SECTION_META[t].tab;
  }

  /** 仓库源文件段没有待保存状态可算，返回 null 让角标不渲染 */
  function chipFor(t: TabKey): { text: string; style: string } | null {
    if (t === 'repo') return null;
    return { text: chipText(t), style: CHIP_STYLE[chipKind(t)] };
  }

  /** 第一次进入才挂载，之后切走只隐藏 —— 编辑到一半的仓库文本不该因为换标签就没了 */
  let repoSeen = $state(false);
  function selectTab(t: TabKey) {
    tab = t;
    if (t === 'repo') repoSeen = true;
  }

  /* -------------------------------------------------------------- 段级操作 */

  function initSection(key: SectionKey) {
    meta[key].initialized = true;
    meta[key].removed = false;
    setForm(key, clone(BLANK[key]));
  }

  function cancelInit(key: SectionKey) {
    meta[key].initialized = false;
    setForm(key, clone(BLANK[key]));
  }

  function removeSection(key: SectionKey) {
    const m = SECTION_META[key];
    if (!confirm(`确定要在保存时删除 ${dataDir}/${m.file} 吗？\n删掉后「${m.label}」回落到 params.toml 的原有配置。`)) return;
    meta[key].removed = true;
  }

  function undoRemove(key: SectionKey) {
    meta[key].removed = false;
    const b = baseline?.[key];
    if (b && meta[key].loaded) setForm(key, clone(b));
  }

  function discardAll() {
    if (!pendingKeys.length) return;
    const names = pendingKeys.map((k) => SECTION_META[k].label).join('、');
    if (!confirm(`放弃「${names}」未保存的改动，恢复到最近一次读取的内容？`)) return;
    for (const k of SECTION_KEYS) {
      meta[k].initialized = false;
      meta[k].removed = false;
      const b = baseline?.[k];
      if (b) setForm(k, clone(b));
    }
    issues = [];
    saveMessage = '';
    saveNote = [];
    saveWritten = [];
    saveError = '';
  }

  /* ------------------------------------------------------------------ 保存 */

  const progressText = $derived.by(() => {
    const parts = [
      ...writeKeys.map((k) => `写入 ${dataDir}/${SECTION_META[k].file}`),
      ...deleteKeys.map((k) => `删除 ${dataDir}/${SECTION_META[k].file}`),
    ];
    return parts.join('、') || '没有要写的文件';
  });

  async function save() {
    saveError = '';
    saveMessage = '';
    saveNote = [];
    saveWritten = [];

    if (!ready) {
      saveError = '还没读到站点现有配置，先点「重新读取」拿到内容再保存，免得把 params.toml 的配置盖掉';
      return;
    }
    const found: Issue[] = [];
    for (const k of writeKeys) found.push(...validateSection(k, forms[k]));
    issues = found;
    if (found.length) {
      tab = found[0].section;
      saveError = `有 ${found.length} 处内容不合法，已经拦下没有提交（清单见上方红框）`;
      return;
    }
    if (!pendingKeys.length) {
      saveError = '没有需要保存的改动：内容没变的段不会重复写入，也不会触发构建';
      return;
    }

    const body: Record<string, unknown> = { triggerBuild };
    for (const k of pendingKeys) body[k] = pendingMap[k] === 'delete' ? null : payloadOf(k, forms[k]);

    saving = true;
    try {
      const res = await post<{ data: SaveResult }>('/api/admin/frontend', body);
      const d = res.data;
      saveMessage = d.message || '已保存';
      saveWritten = d.written ?? [];
      const notes: string[] = [];
      if (d.build?.triggered) notes.push('已请求 Cloudflare Pages 重新构建，前台几分钟内更新。');
      else if (d.build && d.build.triggered === false) notes.push(`站点构建没有自动触发：${d.build.error ?? '未配置 Pages 重建 Hook'}，等下一次自动构建或手动点一次。`);
      else if (triggerBuild) notes.push('后端没有返回构建结果，按未触发处理；前台没更新就手动重建一次。');
      saveNote = notes;
      if (d.notice) saveError = d.notice;
      await load();
    } catch (e) {
      // 后端 400 / 502 的中文 message 原样显示
      saveError = errText(e);
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    void load();
  });

  /** 段级模板里的闭包拿不到 tab 的收窄；这些面板在 tab === 'repo' 时不渲染，兜到第一段即可 */
  const sec = $derived(tab === 'repo' ? ('site' as SectionKey) : tab);

  const activeMeta = $derived(meta[sec]);
  const activeLabel = $derived(SECTION_META[sec].label);
  const activeFile = $derived(SECTION_META[sec].file);
</script>

<div class="row spread head">
  <h2>前端管理</h2>
  <div class="row">
    <span class="muted small">写入位置：<code>{dataDir}/</code></span>
    <button class="sm" onclick={() => void reload()} disabled={loading || saving}>{loading ? '读取中…' : '重新读取'}</button>
  </div>
</div>

<p class="muted small intro">
  这一页管前台的<em>样子</em>：导航栏、首页、页脚、关于页、工坊。保存会写进站点 <code>{dataDir}/</code> 目录下的
  <code>nav.json / home.json / footer.json / about.json / works.json</code>，主题优先读这些文件，读不到才回落到
  <code>params.toml</code>；所以每一段都能单独「删除覆盖」退回原状。评论开关、注册开关这些运行时配置在「设置」页改，不在这儿。
  最后那个「主题配置文件」子标签是直改仓库源文件（<code>params.toml</code> 等）的入口，它有自己的读取与保存，不走下面的统一按钮。
  <strong>本页的保存没有开关可关</strong>：这些 json 就是本页的存储本身，点保存就是一次仓库提交。想让它不再往仓库写，
  就把「设置 → 内容仓库」的 owner / repo 留空（那时本页会明确报错，而不是悄悄存到别处）。
  设置里那个「投稿通过后自动写入仓库」的开关只管投稿页，管不到这里。
</p>

{#if loadError}
  <div class="card errbox">
    <p class="err">{loadError}</p>
    <button class="sm" onclick={() => void reload()} disabled={loading}>重试</button>
  </div>
{/if}

{#if getNotice}
  <p class="warn small note">读取提示：{getNotice}</p>
{/if}

<div class="tabs">
  {#each TABS as t (t)}
    {@const chip = chipFor(t)}
    <button class="tab" class:on={tab === t} onclick={() => selectTab(t)}>
      {tabLabel(t)}
      {#if chip}<span class="n" style={chip.style}>{chip.text}</span>{/if}
    </button>
  {/each}
</div>

{#if repoSeen}
  <!-- 切走子标签只是隐藏：编辑中的仓库文本不会因为销毁组件而丢 -->
  <div style={tab === 'repo' ? '' : 'display: none'}>
    <RepoPanel />
  </div>
{/if}

{#if tab !== 'repo'}
  {#if loading && !ready}
    <p class="muted">正在读取站点 data 目录里的前端配置…</p>
  {:else if !ready}
    <p class="muted">读不到现有配置，原因见上面的提示；修好后点「重新读取」。想直接改仓库里的 params.toml，用最后那个「主题配置文件」子标签。</p>
  {:else}
    {#if shownIssues.length}
      <div class="card issues">
        <div class="row spread">
          <h3>保存前先看一下：{shownIssues.length} 处不合法</h3>
          {#if issues.length}
            <button class="sm ghost" onclick={() => (issues = [])}>收起</button>
          {/if}
        </div>
        {#each shownIssues as x (x.section + x.message)}
          <p class="small">
            <button class="link" onclick={() => (tab = x.section)}>【{SECTION_META[x.section].label}】</button>{x.message}
          </p>
        {/each}
        <p class="muted small">
          规则和后端一致：短文本 ≤{LIMIT.short}、链接 ≤{LIMIT.href}、长文本 ≤{LIMIT.long}；导航 ≤{CAP.nav} 项、备案 ≤{CAP.icp} 条、
          关于页三组段落各 ≤{CAP.paragraph} 段、联系方式 ≤{CAP.contacts} 条、工坊 ≤{CAP.works} 个。
        </p>
      </div>
    {/if}

    <SectionBar
      label={activeLabel}
      file={activeFile}
      {dataDir}
      pending={pendingMap[sec]}
      loaded={activeMeta.loaded}
      initialized={activeMeta.initialized}
      issueCount={issueCountOf(sec)}
      onremove={() => removeSection(sec)}
      oncancel={() => cancelInit(sec)}
    />

    {#if pendingMap[sec] === 'delete'}
      <RemovedCard label={activeLabel} file={activeFile} {dataDir} onundo={() => undoRemove(sec)} />
    {:else if !activeMeta.loaded && !activeMeta.initialized}
      <FallbackCard label={activeLabel} file={activeFile} {dataDir} oninit={() => initSection(sec)} />
    {:else if sec === 'site'}
      <SitePanel site={forms.site} />
    {:else if sec === 'nav'}
      <NavPanel nav={forms.nav} />
    {:else if sec === 'home'}
      <HomePanel home={forms.home} />
    {:else if sec === 'footer'}
      <FooterPanel footer={forms.footer} />
    {:else if sec === 'about'}
      <AboutPanel about={forms.about} />
    {:else if sec === 'moments'}
      <MomentsPanel moments={forms.moments} />
    {:else if sec === 'works'}
      <WorksPanel works={forms.works} />
    {:else}
      <SeoPanel seo={forms.seo} />
    {/if}

    {#if notesOfActive.length}
      <section class="card notes">
        <h3>提示（不影响保存）</h3>
        {#each notesOfActive as n (n)}<p class="muted small">{n}</p>{/each}
      </section>
    {/if}
  {/if}
{/if}

{#if tab !== 'repo'}
  <footer class="bar card">
    <div class="row spread top">
      <div class="row summ">
        {#if !ready}
          <span class="badge bad">还没读到配置</span>
          <span class="muted small">先修好上面的读取错误，点「重新读取」成功后再编辑保存。</span>
        {:else if saving}
          <span class="badge pending">保存中…</span>
          <span class="muted small">{progressText}（一次请求，最多一次构建）</span>
        {:else if pendingKeys.length}
          <span class="badge">{pendingKeys.length} 段待保存</span>
          <span class="muted small">{pendingKeys.map((k) => `${SECTION_META[k].label}${pendingMap[k] === 'delete' ? '（删除）' : ''}`).join('、')}</span>
          {#if liveIssues.length}
            <span class="badge bad">{liveIssues.length} 处待修正</span>
          {:else}
            <span class="muted small">内容没变的段不会重复写入</span>
          {/if}
        {:else}
          <span class="badge good">没有待保存的改动</span>
          <span class="muted small">改了某一段内容，或点了某一段的「从空白开始填写」，这里就会列出要写的段</span>
        {/if}
      </div>
      <div class="row acts">
        <label class="switch">
          <input type="checkbox" bind:checked={triggerBuild} disabled={saving} />
          <span>保存后触发站点构建</span>
        </label>
        <button class="sm" onclick={discardAll} disabled={saving || !ready || !pendingKeys.length}>放弃改动</button>
        <button class="primary" onclick={() => void save()} disabled={saving || !ready}>
          {saving ? '保存中…' : pendingKeys.length ? `保存设置（${pendingKeys.length} 段）` : '保存设置'}
        </button>
      </div>
    </div>

    {#if saveError}<p class="err small">{saveError}</p>{/if}
    {#if saveMessage}<p class="ok small">{saveMessage}</p>{/if}
    {#if saveWritten.length}<p class="muted small">本次写入 / 删除的文件：{saveWritten.join('、')}</p>{/if}
    {#each saveNote as n (n)}<p class="muted small">{n}</p>{/each}
    {#if droppedActive}<p class="muted small">这一段里有整行空白的条目，保存时会自动丢掉（主题本来也不显示空条目）。</p>{/if}
  </footer>
{/if}

<style>
  .head {
    margin-bottom: 0.5rem;
  }
  .intro {
    margin: 0 0 0.7rem;
    line-height: 1.75;
  }
  .intro code {
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0 0.22rem;
  }
  .small {
    font-size: 0.78rem;
  }
  .note {
    margin: 0 0 0.6rem;
  }
  .errbox {
    margin-bottom: 0.7rem;
    display: flex;
    gap: 0.6rem;
    align-items: center;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.7rem;
  }
  .tab {
    padding: 0.24rem 0.7rem;
    font-size: 0.84rem;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .tab.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .n {
    font-size: 0.7rem;
    border-radius: 999px;
    padding: 0.02rem 0.42rem;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .tab.on .n {
    background: rgba(255, 255, 255, 0.22);
    color: #fff;
  }
  .issues {
    margin-bottom: 0.7rem;
    border-color: #fecaca;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .issues h3 {
    margin: 0;
    font-size: 0.92rem;
    color: var(--bad);
  }
  .issues p {
    margin: 0.15rem 0;
    line-height: 1.6;
  }
  .link {
    border: 0;
    background: transparent;
    color: var(--bad);
    padding: 0;
    font-size: 0.78rem;
  }
  .notes {
    margin-top: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .notes h3 {
    margin: 0 0 0.2rem;
    font-size: 0.9rem;
  }
  .notes p {
    margin: 0;
    line-height: 1.65;
  }
  .bar {
    position: sticky;
    bottom: 0;
    margin-top: 0.9rem;
    z-index: 5;
    box-shadow: 0 -2px 10px rgba(17, 24, 39, 0.06);
  }
  .top {
    align-items: center;
  }
  .summ {
    gap: 0.5rem;
    min-width: 0;
  }
  .acts {
    flex: none;
    gap: 0.5rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--fg);
  }
  .badge.bad {
    background: #fee2e2;
    color: var(--bad);
  }
</style>
