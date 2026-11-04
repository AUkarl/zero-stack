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

  const preview = $derived(frontUrl('/home/'));

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
  });
</script>

<div class="row spread head">
  <div>
    <h2>AI PET</h2>
    <p class="muted small">
      控制全站 AI 桌宠的默认行为。设置写入内容仓库的 <code>{filePath}</code>，刷新前台生效；本地构建监听会自动重建，线上保存后会触发构建。首页（<code>/</code>）、账号页、分类/标签/作者页与 404 永远不显示。
    </p>
    <p class="muted small">
      昵称、头像、身份组沿用 <a href="/ai">AI 回复 → AI 身份设置</a>；这里只控制行为和外观。
    </p>
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
  .head p + p {
    margin-top: 0.25rem;
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
