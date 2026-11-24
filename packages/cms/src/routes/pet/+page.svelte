<script lang="ts">
  import { onMount } from 'svelte';
  import { get, post } from '#lib/api';
  import { frontUrl } from '#lib/session.svelte';
  import { toast } from '#lib/toast.svelte';

  interface PetCfg {
    enabled: boolean;
    size: 's' | 'm' | 'l';
    corner: 'left' | 'right';
    mobileMode: 'mini' | 'full' | 'hidden';
    autoActions: boolean;
    idleMin: number;
    idleMax: number;
    aiEnabled: boolean;
    greetingEnabled: boolean;
    clickReaction: boolean;
    feedEnabled: boolean;
    sleepEnabled: boolean;
    dragEnabled: boolean;
    dockEnabled: boolean;
    scrollReaction: boolean;
    likeReaction: boolean;
    commentReaction: boolean;
    backTopReaction: boolean;
    creditEnabled: boolean;
  }

  type EventKind = 'chat' | 'feed' | 'poke' | 'sleep' | 'wake';
  type EventFilter = 'all' | EventKind;

  interface PetEvent {
    id: string;
    kind: EventKind;
    question: string | null;
    reply: string | null;
    page: string | null;
    section: string | null;
    mood: string | null;
    trigger: string | null;
    createdAt: number;
  }

  const EVENT_FILTERS: { key: EventFilter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'chat', label: '聊天' },
    { key: 'feed', label: '投喂' },
    { key: 'poke', label: '摸摸' },
    { key: 'sleep', label: '睡觉' },
    { key: 'wake', label: '起床' },
  ];

  const EVENT_LABEL: Record<EventKind, string> = {
    chat: '聊天',
    feed: '投喂',
    poke: '摸摸',
    sleep: '睡觉',
    wake: '起床',
  };

  const EVENT_ACTION: Record<EventKind, string> = {
    chat: '',
    feed: '给鲸鱼娘喂了一碗白米饭',
    poke: '摸了摸鲸鱼娘',
    sleep: '哄鲸鱼娘睡觉',
    wake: '叫醒了鲸鱼娘',
  };

  const DEFAULTS: PetCfg = {
    enabled: true,
    size: 'm',
    corner: 'left',
    mobileMode: 'full',
    autoActions: true,
    idleMin: 6,
    idleMax: 14,
    aiEnabled: true,
    greetingEnabled: true,
    clickReaction: true,
    feedEnabled: true,
    sleepEnabled: true,
    dragEnabled: true,
    dockEnabled: true,
    scrollReaction: true,
    likeReaction: true,
    commentReaction: true,
    backTopReaction: true,
    creditEnabled: true,
  };

  let cfg = $state<PetCfg>({ ...DEFAULTS });
  let ready = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let loadError = $state('');
  let filePath = $state('data/pet.json');
  let backend = $state('');

  let events = $state<PetEvent[]>([]);
  let eventKind = $state<EventFilter>('all');
  let eventCounts = $state<Record<string, number>>({});
  let eventTotal = $state(0);
  let eventsLoading = $state(false);
  let eventsLoaded = $state(false);
  let eventsError = $state('');
  let eventsSeq = 0;

  const preview = $derived(frontUrl('/home/'));

  function formatEventTime(sec: number): string {
    return new Date(sec * 1000).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  async function loadEvents(reset = true) {
    const seq = ++eventsSeq;
    const kind = eventKind;
    const offset = reset ? 0 : events.length;
    eventsLoading = true;
    eventsError = '';
    try {
      const res = await get<{
        data: { events: PetEvent[]; total: number; counts: Record<string, number> };
      }>(`/api/admin/pet/events?kind=${kind}&limit=20&offset=${offset}`);
      if (seq !== eventsSeq) return;
      events = reset ? res.data.events : [...events, ...res.data.events];
      eventTotal = res.data.total;
      eventCounts = res.data.counts || {};
      eventsLoaded = true;
    } catch (e) {
      if (seq === eventsSeq) eventsError = e instanceof Error ? e.message : '读取互动记录失败';
    } finally {
      if (seq === eventsSeq) eventsLoading = false;
    }
  }

  function setEventKind(kind: EventFilter) {
    if (eventKind === kind) return;
    eventKind = kind;
    void loadEvents(true);
  }

  async function load() {
    loading = true;
    loadError = '';
    try {
      const res = await get<{ data: { data: PetCfg; path: string; backend: string } }>('/api/admin/pet');
      cfg = { ...DEFAULTS, ...res.data.data };
      filePath = res.data.path || 'data/pet.json';
      backend = res.data.backend || '';
      ready = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : '读取失败';
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (saving) return;
    saving = true;
    try {
      const res = await post<{ data: { message: string; buildHealth: { ran?: boolean; ok: boolean; errors?: string[] } | null } }>(
        '/api/admin/pet',
        cfg,
      );
      const h = res.data.buildHealth;
      if (h && h.ran === true && h.ok === false) {
        toast.err(`设置已保存，但站点构建失败，前台可能停在上一版：${(h.errors ?? []).join('；') || '请看 repo bridge 日志'}`);
      } else {
        toast.ok(res.data.message || '设置已保存');
      }
    } catch (e) {
      toast.err(e instanceof Error ? e.message : '保存失败');
    } finally {
      saving = false;
    }
  }

  function resetDefaults() {
    cfg = { ...DEFAULTS };
    toast.ok('已恢复默认值，点右上角「保存设置」后写入站点');
  }

  onMount(() => {
    void load();
    void loadEvents(true);
  });
</script>

<div class="row spread head">
  <div>
    <h2>AI PET</h2>
    <p class="muted small">昵称与头像沿用 <a href="/ai">AI 身份设置</a>。</p>
  </div>
  <div class="row">
    {#if preview}
      <a class="sm linkbtn" href={preview} target="_blank" rel="noreferrer">预览前台</a>
    {/if}
    <button class="sm" type="button" onclick={() => void load()} disabled={loading || saving}>{loading ? '读取中…' : '刷新'}</button>
    <button class="primary" type="button" onclick={() => void save()} disabled={!ready || saving}>
      {saving ? '保存中…' : '保存设置'}
    </button>
  </div>
</div>

{#if loadError}
  <p class="err card">{loadError}</p>
{:else if !ready}
  <p class="muted card">读取中…</p>
{:else}
  <section class="card">
    <div class="row spread">
      <h3>显示与外观</h3>
      <span class="badge {cfg.enabled ? 'good' : 'pending'}">{cfg.enabled ? '已启用' : '已停用'}</span>
    </div>
    <label class="switch">
      <input type="checkbox" bind:checked={cfg.enabled} />
      <span>启用 AI PET</span>
    </label>
    <div class="fields">
      <label>
        默认大小
        <select bind:value={cfg.size}>
          <option value="s">小</option>
          <option value="m">中</option>
          <option value="l">大</option>
        </select>
      </label>
      <label>
        默认位置
        <select bind:value={cfg.corner}>
          <option value="left">左下角</option>
          <option value="right">右下角</option>
        </select>
      </label>
      <label>
        手机端
        <select bind:value={cfg.mobileMode}>
          <option value="mini">先显示 48px 头像，点了展开</option>
          <option value="full">直接展开全身桌宠</option>
          <option value="hidden">手机端不显示</option>
        </select>
        <span class="muted hint">访客拖过位置或改过大小后，以本机偏好为准。</span>
      </label>
    </div>
    <div class="bools">
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.dockEnabled} /><span>显示工具栏</span></label>
        <span class="muted hint">聊天 / 喂饭 / 动作 / 睡觉 / 隐藏；关闭后只能点击她互动。</span>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.creditEnabled} /><span>显示素材署名</span></label>
        <span class="muted hint">动作菜单底部显示动画素材来源。</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h3>行为</h3>
    <div class="bools">
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.autoActions} /><span>自动随机做动作</span></label>
        <span class="muted hint">页面可见且没有打开面板时，每隔一段时间自己动一下。</span>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.greetingEnabled} /><span>首次进入时打招呼</span></label>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.clickReaction} /><span>点击她时有反应</span></label>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.feedEnabled} /><span>允许喂饭</span></label>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.sleepEnabled} /><span>允许睡觉 / 久坐后自动睡</span></label>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.dragEnabled} /><span>允许拖动换位置</span></label>
      </div>
    </div>
    <div class="fields pair">
      <label>
        动作最短间隔（秒）
        <input type="number" min="3" max="120" bind:value={cfg.idleMin} />
      </label>
      <label>
        动作最长间隔（秒）
        <input type="number" min="3" max="180" bind:value={cfg.idleMax} />
        <span class="muted hint">最长间隔不能小于最短间隔。</span>
      </label>
    </div>
  </section>

  <section class="card">
    <h3>AI</h3>
    <label class="switch">
      <input type="checkbox" bind:checked={cfg.aiEnabled} />
      <span>启用 AI 台词与提问</span>
    </label>
    <p class="muted hint">
      关闭后仍保留本地兜底台词。AI 服务商、模型、密钥、人设补充和昵称/头像/身份组都沿用 <a href="/ai">AI 回复</a> 的设置，聊天会直接使用同一套 API。
    </p>
  </section>

  <section class="card">
    <div class="row spread">
      <h3>互动记录</h3>
      <button class="sm" type="button" onclick={() => void loadEvents(true)} disabled={eventsLoading}>
        {eventsLoading ? '读取中…' : '刷新'}
      </button>
    </div>
    <div class="event-filters">
      {#each EVENT_FILTERS as f (f.key)}
        <button class="sm" type="button" class:active={eventKind === f.key} onclick={() => setEventKind(f.key)}>
          {f.label}{f.key === 'all' ? ` ${eventTotal}` : eventCounts[f.key] ? ` ${eventCounts[f.key]}` : ''}
        </button>
      {/each}
    </div>
    <p class="muted hint">聊天、投喂、摸摸、睡觉/起床都会记在这里；不记访客 IP，90 天后自动清理。</p>
    {#if eventsError}
      <p class="err">{eventsError}</p>
    {:else if eventsLoading && !events.length}
      <p class="muted small">读取中…</p>
    {:else if events.length}
      <ul class="event-list">
        {#each events as event (event.id)}
          <li class="event-item">
            <span class="event-kind">{EVENT_LABEL[event.kind]}</span>
            <div class="event-main">
              {#if event.kind === 'chat'}
                <p class="event-q">问：{event.question || '（未记录问题）'}</p>
                <p class="event-a">答：{event.reply || '（未记录回复）'}</p>
              {:else}
                <p class="event-line">{EVENT_ACTION[event.kind]}</p>
              {/if}
              <p class="event-meta">
                <span>{formatEventTime(event.createdAt)}</span>
                {#if event.page || event.section}<span>· {event.page || event.section}</span>{/if}
                {#if event.mood}<span>· 心情 {event.mood}</span>{/if}
              </p>
            </div>
          </li>
        {/each}
      </ul>
      {#if events.length < eventTotal}
        <button class="sm event-more" type="button" onclick={() => void loadEvents(false)} disabled={eventsLoading}>
          {eventsLoading ? '读取中…' : `加载更多（已显示 ${events.length}/${eventTotal}）`}
        </button>
      {/if}
    {:else if eventsLoaded}
      <p class="muted small">还没有记录。访客在前台和鲸鱼娘聊天、喂饭后会出现在这里。</p>
    {/if}
  </section>

  <section class="card">
    <h3>网页联动</h3>
    <div class="bools">
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.scrollReaction} /><span>滚动阅读时做反应</span></label>
        <span class="muted hint">读到 25% / 50% / 75% / 底部时各有动作。</span>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.likeReaction} /><span>点赞或收藏时做反应</span></label>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.commentReaction} /><span>新评论出现时做反应</span></label>
        <span class="muted hint">固定 code 动作 + “有人发评论了我看看写的什么”。</span>
      </div>
      <div class="bool">
        <label class="switch"><input type="checkbox" bind:checked={cfg.backTopReaction} /><span>回到顶部 / 底部时做反应</span></label>
      </div>
    </div>
    <p class="muted hint">
      主题切换、搜索、复制 / 分享、订阅、评论框聚焦、外链点击和切回标签页也会联动（常开）。同一页面 20 秒内不重复要 AI 台词。
    </p>
  </section>

  <section class="card">
    <div class="row spread">
      <h3>维护</h3>
      <span class="muted small">当前仓库后端：{backend || '未知'}</span>
    </div>
    <p class="muted hint path">设置文件：<code>{filePath}</code></p>
    <div class="row">
      <button class="sm" type="button" onclick={resetDefaults} disabled={saving}>恢复默认值</button>
      <span class="muted hint">恢复后点右上角「保存设置」才会写入站点。</span>
    </div>
  </section>
{/if}

<style>
  .head h2 {
    margin: 0 0 0.3rem;
  }
  .head p {
    margin: 0;
    max-width: 60rem;
    line-height: 1.7;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    margin: 0 0 0.8rem;
  }
  .card:last-of-type {
    margin-bottom: 0;
  }
  .card h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .fields {
    display: grid;
    grid-template-columns: var(--t-3);
    gap: 0.65rem 0.8rem;
  }
  .fields label {
    min-width: 0;
  }
  .fields label > input,
  .fields label > select {
    width: 100%;
  }
  .fields.pair {
    grid-template-columns: var(--t-2);
  }
  .bools {
    display: grid;
    grid-template-columns: var(--t-2);
    gap: 0.55rem 1rem;
  }
  .bool {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    color: var(--fg);
    font-size: 0.85rem;
  }
  .switch input {
    width: auto;
    flex: none;
  }
  .hint {
    font-size: 0.72rem;
    line-height: 1.55;
  }
  .small {
    font-size: 0.78rem;
  }
  .path {
    word-break: break-all;
  }
  .head .row {
    flex-wrap: wrap;
  }
  .event-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .event-filters button.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .event-list {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .event-item {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel-2);
  }
  .event-kind {
    flex: 0 0 auto;
    padding: 0.08rem 0.45rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.7rem;
    line-height: 1.5;
  }
  .event-main {
    flex: 1;
    min-width: 0;
  }
  .event-q,
  .event-a,
  .event-line {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  .event-a {
    margin-top: 0.15rem;
    color: var(--muted);
  }
  .event-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0.3rem 0 0;
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.5;
  }
  .event-more {
    align-self: flex-start;
  }
  @media (max-width: 640px) {
    .head .row {
      width: 100%;
    }
    .head .row > button,
    .head .row > a {
      flex: 1 1 auto;
      justify-content: center;
    }
    .bools {
      grid-template-columns: 1fr;
    }
  }
</style>
