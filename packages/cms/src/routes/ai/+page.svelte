<script lang="ts">
  import { get, patch, post } from '#lib/api';
  import { timeAgo } from '#lib/api';
  import { renderMarkdown } from '#lib/markdown';
  import { frontUrl } from '#lib/session.svelte';

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

  let status = $state<AiStatus | null>(null);
  let replies = $state<ReplyRow[]>([]);
  let loading = $state(false);
  let error = $state('');
  let notice = $state('');

  let replyEnabled = $state(false);
  let scope = $state<'all' | 'questions'>('all');
  let prompt = $state('');
  let savedEnabled = $state(false);
  let savedScope = $state<'all' | 'questions'>('all');
  let savedPrompt = $state('');
  let saving = $state(false);

  let testing = $state(false);
  let testResult = $state<{ ok: boolean; text: string } | null>(null);

  const dirty = $derived(
    replyEnabled !== savedEnabled || scope !== savedScope || prompt !== savedPrompt,
  );
  const providerInfo = $derived(status?.providers.find((p) => p.kind === status?.provider) ?? null);

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  function flash(text: string) {
    notice = text;
    setTimeout(() => (notice = ''), 3000);
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
      scope = cfg.data.aiReplyScope === 'questions' ? 'questions' : 'all';
      prompt = cfg.data.aiReplyPrompt ?? '';
      savedEnabled = replyEnabled;
      savedScope = scope;
      savedPrompt = prompt;
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
      });
      savedEnabled = replyEnabled;
      savedScope = scope;
      savedPrompt = prompt;
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
    <p class="muted small">读者在你文章下留言后，让大模型以站长身份回一条；只回顶层评论，不回复回复。</p>
  </div>
  <div class="row">
    <a class="sm linkbtn" href="/spam">AI 审核设置</a>
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
  </div>
</div>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

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
      <span class="muted small">会真发一次极短的请求，成功只代表端点、模型与密钥能用。</span>
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
  <p class="muted small">
    只在评论审核通过后触发；以站长账号发布，并走正常的「被回复」提醒邮件。
    模型超时、报错或额度用完时这条回复就不发，评论本身不受影响。
  </p>
  <label>
    回复范围
    <select value={scope} onchange={(e) => (scope = e.currentTarget.value === 'questions' ? 'questions' : 'all')}>
      <option value="all">所有顶层评论</option>
      <option value="questions">只回提问（带问号 / 怎么 / 如何 / 为什么 / 吗 / 呢 等）</option>
    </select>
    <span class="muted hint">「谢谢」「路过」这类留言在「只回提问」下不会触发模型，省额度。</span>
  </label>
  <label>
    站长人设 / 补充要求（选填）
    <textarea
      rows="5"
      maxlength="2000"
      placeholder={'例如：称呼读者为「朋友」；语气温和；不要用感叹号；不要承诺具体时间；可以邀请对方继续讨论。'}
      value={prompt}
      oninput={(e) => (prompt = e.currentTarget.value)}></textarea>
    <span class="muted hint">会追加到系统提示词里，只影响自动回复，不影响审核判定。留空就用默认口吻。</span>
  </label>
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
    <p class="muted small">还没有 AI 回复。开启后收到新的顶层评论就会出现在这里。</p>
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

<section class="card note">
  <h3>AI 审核</h3>
  <p class="muted small">
    AI 审核的开关、模型状态和逐条「AI 复核」在 <a href="/spam">评论审核</a> 页；
    与自动回复共用这里的服务商、模型与密钥，但两个开关互不影响。
  </p>
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
