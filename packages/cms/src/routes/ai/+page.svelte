<script lang="ts">
  import { get, patch, post } from '#lib/api';
  import { timeAgo } from '#lib/api';
  import { renderMarkdown } from '#lib/markdown';
  import { frontUrl } from '#lib/session.svelte';
  import { flash as watchError, toast } from '#lib/toast.svelte';

  interface ProviderInfo {
    kind: string;
    label: string;
    endpoint: string;
    model: string;
    needsKey: boolean;
    hint: string;
  }
  interface AiStatus {
    provider: string;
    label: string;
    endpoint: string;
    model: string;
    keySet: boolean;
    moderation: boolean;
    reply: boolean;
    ready: boolean;
    hint: string;
    providers: ProviderInfo[];
  }
  interface ReplyRow {
    id: string;
    postSlug: string;
    postTitle?: string;
    content: string;
    createdAt: number;
  }

  type ReplyScope = 'all' | 'questions' | 'conversation' | 'every';
  const replyScopeOf = (value: string): ReplyScope =>
    value === 'questions' || value === 'conversation' || value === 'every' ? value : 'all';

  let status = $state<AiStatus | null>(null);
  let replies = $state<ReplyRow[]>([]);
  let loading = $state(false);
  let error = $state('');
  watchError('err', () => error);

  let replyEnabled = $state(false);
  let scope = $state<ReplyScope>('all');
  let maxDepth = $state(6);
  let prompt = $state('');
  let savedEnabled = $state(false);
  let savedScope = $state<ReplyScope>('all');
  let savedPrompt = $state('');
  /** AI 身份三件套：昵称 / 头像地址 / 用户组标识。全留空 = 用站长自己那一份身份 */
  let idName = $state('');
  let idImage = $state('');
  let idGroup = $state('');
  let savedIdName = $state('');
  let savedIdImage = $state('');
  let savedIdGroup = $state('');
  let saving = $state(false);

  let testing = $state(false);
  let testResult = $state<{ ok: boolean; text: string } | null>(null);

  const dirty = $derived(
    replyEnabled !== savedEnabled ||
      scope !== savedScope ||
      prompt !== savedPrompt ||
      idName !== savedIdName ||
      idImage !== savedIdImage ||
      idGroup !== savedIdGroup,
  );
  /** 三格都空着时前台那条回复就是站长本人的样子 */
  const providerInfo = $derived(status?.providers.find((p) => p.kind === status?.provider) ?? null);

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  /** 结果只走右上角浮层，不再在页面顶部占一行 */
  function flash(text: string) {
    toast.ok(text);
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const [st, cfg, rp] = await Promise.all([
        get<{ data: AiStatus }>('/api/admin/ai/status'),
        get<{ data: Record<string, string> }>('/api/admin/config'),
        get<{ data: ReplyRow[] }>('/api/admin/ai/replies?limit=20'),
      ]);
      status = st.data;
      replies = rp.data ?? [];
      replyEnabled = String(cfg.data.aiReplyEnabled ?? '') === 'true';
      scope = replyScopeOf(String(cfg.data.aiReplyScope ?? ''));
      maxDepth = Number(cfg.data.commentMaxDepth ?? 6) || 6;
      prompt = cfg.data.aiReplyPrompt ?? '';
      idName = cfg.data.aiReplyName ?? '';
      idImage = cfg.data.aiReplyImageUrl ?? '';
      idGroup = cfg.data.aiReplyGroup ?? '';
      savedEnabled = replyEnabled;
      savedScope = scope;
      savedPrompt = prompt;
      savedIdName = idName;
      savedIdImage = idImage;
      savedIdGroup = idGroup;
    } catch (e) {
      error = msg(e);
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!dirty || saving) return;
    saving = true;
    error = '';
    try {
      await patch('/api/admin/config', {
        aiReplyEnabled: replyEnabled,
        aiReplyScope: scope,
        aiReplyPrompt: prompt,
        aiReplyName: idName.trim(),
        aiReplyImageUrl: idImage.trim(),
        aiReplyGroup: idGroup.trim(),
      });
      savedEnabled = replyEnabled;
      savedScope = scope;
      savedPrompt = prompt;
      savedIdName = idName.trim();
      savedIdImage = idImage.trim();
      savedIdGroup = idGroup.trim();
      status = (await get<{ data: AiStatus }>('/api/admin/ai/status')).data;
      flash(replyEnabled ? 'AI 回复设置已保存' : '已关闭 AI 自动回复');
    } catch (e) {
      error = msg(e);
    } finally {
      saving = false;
    }
  }

  async function testConnection() {
    testing = true;
    testResult = null;
    try {
      const d = await post<{ data: { reply: string } }>('/api/admin/ai/probe');
      testResult = { ok: true, text: `连接成功，模型回：${d.data.reply}` };
    } catch (e) {
      testResult = { ok: false, text: msg(e) };
    } finally {
      testing = false;
    }
  }

  $effect(() => void load());
</script>

<div class="row spread head">
  <div>
    <h2>AI 回复</h2>
  </div>
  <div class="row">
    <a class="sm linkbtn" href="/spam">AI 审核设置</a>
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
  </div>
</div>

<section class="card">
  <div class="row spread">
    <h3>连接状态</h3>
    {#if status}
      <span class="badge {status.ready ? 'good' : 'pending'}">{status.ready ? '已就绪' : '未配置'}</span>
    {/if}
  </div>
  {#if status}
    <p class="small">
      服务商 <b>{status.label}</b> · 模型 <b>{status.model || '—'}</b>
      {#if status.keySet}<span class="badge good">密钥已设置</span>{:else}<span class="badge pending">未填密钥</span>{/if}
    </p>
    <p class="muted small path">{status.endpoint || '（端点为空）'}</p>
    {#if providerInfo?.hint}<p class="muted small">{providerInfo.hint}</p>{/if}
    {#if !status.ready}
      <p class="warn small">
        还没有可用的 AI{status.hint ? `：${status.hint}` : ''}。到
        <a href="/settings">「设置 → AI 模型配置」</a>
        补齐；自建 Ollama / vLLM 选「自定义」并填端点与模型。
      </p>
    {/if}
    <div class="row">
      <button class="sm" onclick={() => void testConnection()} disabled={testing || !status.ready}>
        {testing ? '测试中…' : '测试连接'}
      </button>
    </div>
    {#if testResult}<p class="small {testResult.ok ? 'ok' : 'err'}">{testResult.text}</p>{/if}
  {:else if loading}
    <p class="muted small">读取中…</p>
  {/if}
</section>

<section class="card">
  <h3>自动回复</h3>
  <label class="switch">
    <input
      type="checkbox"
      checked={replyEnabled}
      onchange={(e) => (replyEnabled = e.currentTarget.checked)}
      disabled={!status?.ready && !replyEnabled}
    />
    <span>开启 AI 自动回复</span>
  </label>
  {#if !status?.ready && !replyEnabled}
    <p class="warn small">先把上面的连接配好（服务商、密钥、模型），才能开启自动回复。</p>
  {/if}
  <label>
    回复范围
    <select value={scope} onchange={(e) => (scope = replyScopeOf(e.currentTarget.value))}>
      <option value="all">回复顶层评论（所有顶层）</option>
      <option value="questions">只回复疑问问题（顶层带问号 / 怎么 / 如何 / 为什么 / 吗 / 呢 等）</option>
      <option value="conversation">对话式回复（顶层 + 直接回复 AI 的楼中楼）</option>
      <option value="every">全部回复（顶层 + 所有层级）</option>
    </select>
    <span class="muted hint">
      当前最大层级：{maxDepth} 层（<a href="/settings">设置 → 评论</a> 可调）。
    </span>
  </label>
  <label>
    站长人设 / 补充要求（选填）
    <textarea
      rows="5"
      maxlength="2000"
      placeholder={'例如：称呼读者为「朋友」；语气温和；不要用感叹号；不要承诺具体时间；可以邀请对方继续讨论。'}
      value={prompt}
      oninput={(e) => (prompt = e.currentTarget.value)}></textarea>
  </label>

  <h3 class="sub">AI 身份设置（选填）</h3>
  <div class="fields">
    <label>
      昵称
      <input type="text" maxlength="40" value={idName} oninput={(e) => (idName = e.currentTarget.value)} placeholder={status?.ready ? '留空 = 用你的昵称' : '留空 = 用你的昵称'} />
    </label>
    <label>
      头像地址
      <input type="text" maxlength="500" value={idImage} oninput={(e) => (idImage = e.currentTarget.value)} placeholder="https://…/ai.png（留空 = 用站长头像）" />
    </label>
    <label>
      用户组标识
      <input type="text" maxlength="20" value={idGroup} oninput={(e) => (idGroup = e.currentTarget.value)} placeholder="例如「AI 助手」，留空用默认那四个字" />
    </label>
  </div>
  <div class="row">
    <button class="primary" onclick={() => void save()} disabled={saving || !dirty}>{saving ? '保存中…' : '保存回复设置'}</button>
    {#if dirty}<span class="muted small">有未保存的修改</span>{/if}
  </div>
</section>

<section class="card">
  <div class="row spread">
    <h3>最近 AI 回复</h3>
    <span class="muted small">最新 20 条</span>
  </div>
  {#if replies.length === 0}
    <p class="muted small">暂无。</p>
  {:else}
    <div class="replies">
      {#each replies as r (r.id)}
        <article class="reply">
          <div class="row spread">
            <span class="small">
              {#if frontUrl(r.postSlug)}
                <a href={frontUrl(r.postSlug)} target="_blank" rel="noreferrer">{r.postTitle || r.postSlug}</a>
              {:else}
                <span class="muted">{r.postTitle || r.postSlug}</span>
              {/if}
            </span>
            <span class="muted small">{timeAgo(r.createdAt)}</span>
          </div>
          <div class="content">{@html renderMarkdown(r.content, { shortBase: frontUrl('/posts/') || '/posts/' })}</div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .head {
    margin-bottom: 0.8rem;
    align-items: flex-start;
  }
  .head h2 {
    margin-bottom: 0.2rem;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin-bottom: 0.8rem;
  }
  .card h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  /* 「AI 身份设置」那一组的小标题：比卡片标题轻一档，但仍是一节的开头 */
  .sub {
    margin: 0.5rem 0 0;
    padding-top: 0.7rem;
    border-top: 1px dashed var(--border);
    font-size: 0.92rem;
  }
  .fields {
    display: grid;
    grid-template-columns: var(--t-3);
    gap: 0.6rem 0.8rem;
  }
  .fields label > input {
    width: 100%;
    height: var(--ctl-h);
  }
  .small {
    font-size: 0.78rem;
  }
  .hint {
    font-size: 0.72rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
  }
  .path {
    word-break: break-all;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
  }
  textarea {
    width: 100%;
  }
  .replies {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .reply {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.55rem 0.7rem;
    background: var(--panel-2);
  }
  .reply .content {
    font-size: 0.84rem;
    margin-top: 0.25rem;
  }
  .note {
    background: transparent;
  }
</style>
