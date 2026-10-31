<script lang="ts">
  import { flash } from '#lib/toast.svelte';
  import { get, patch, post, put } from '#lib/api';
  import { timeAgo } from '#lib/api';
  import { renderMarkdown } from '#lib/markdown';
  import { frontUrl } from '#lib/session.svelte';

  /** 后端 RuleHit：来源 + 规则原文 + 说明 + 权重；旧版接口可能仍回字符串，两种都要能渲染 */
  interface RuleHit {
    source?: 'text' | 'regex' | 'file' | 'provider' | string;
    pattern?: string;
    label?: string;
    weight?: number;
  }
  interface Verdict {
    spam: boolean;
    score: number;
    reason: string;
    hold: boolean;
    rules?: (string | RuleHit)[];
    provider?: { kind?: string; ok?: boolean; label?: string; raw?: unknown; error?: string | null } | null;
  }
  /** 渲染用的归一化命中项 */
  interface ProbeRule {
    key: string;
    sourceLabel: string;
    pattern: string;
    label: string;
    weight: number | null;
  }
  interface Cmt {
    id: string;
    postSlug: string;
    /** 接口从内容仓库 front matter 认出来的标题；认不到为空，界面回落到地址 */
    postTitle?: string;
    authorName: string;
    authorEmail: string | null;
    content: string;
    status: string;
    spamScore: number | null;
    spamReason: string | null;
    createdAt: number;
  }

  const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

  const PROVIDER_KINDS: [string, string][] = [
    ['none', '不使用'],
    ['generic', '自建 HTTP 服务'],
    ['netease', '网易易盾'],
    ['aliyun', '阿里绿网（内容安全）'],
    ['tencent', '腾讯云天御（内容安全）'],
    ['moderatejs', 'moderate.js 自建服务'],
  ];

  /** RuleHit.source → 人话标签 */
  const SOURCE_LABELS: Record<string, string> = {
    text: '关键词',
    builtin: '默认规则集',
    regex: '正则',
    file: '规则文件',
    provider: '服务商',
  };

  const RULE_KEYS = [
    'spamEnabled',
    'spamThreshold',
    'spamHoldPending',
    'spamRuleWeight',
    'spamUseBuiltinPatterns',
    'spamLinkRatio',
    'spamKeywords',
    'spamCustomRegex',
    'spamProviderKind',
  ] as const;

  let cfg = $state<Record<string, string>>({});
  let saved = $state<Record<string, string>>({});
  let keywords = $state<string[]>([]);
  let customRegex = $state('');
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');
  /* 顶部那行结果提示改走右上角浮层（页面一长就看不见那行小字） */
  flash('err', () => error);
  flash('ok', () => notice);

  // 仓库正则文件：路径一律用后端回的那个，前端不硬写
  let pfPath = $state('');
  let pfText = $state('');
  let pfSaved = $state('');
  let pfLoading = $state(false);
  let pfSaving = $state(false);
  let pfError = $state('');
  let pfNotice = $state('');
  let pfMissing = $state(false);

  // 试跑
  let probe = $state({ content: '', name: '', email: '', link: '' });
  let verdict = $state<Verdict | null>(null);
  let probing = $state(false);
  let aiProbe = $state<{ verdict: string; reason: string } | null>(null);
  let aiProbing = $state(false);

  // AI 审核：连接配置在「设置 → AI 模型配置」，这里只管开关与试判
  interface AiStatusLite {
    provider: string;
    label: string;
    endpoint: string;
    model: string;
    keySet: boolean;
    moderation: boolean;
    reply: boolean;
    ready: boolean;
    hint: string;
  }
  let ai = $state<AiStatusLite | null>(null);
  let aiToggleBusy = $state(false);

  // 队列
  let queue = $state<Cmt[]>([]);
  let queueStatus = $state<'spam' | 'pending'>('spam');
  let expandedContent = $state<Set<string>>(new Set());
  function toggleContent(id: string) {
    const next = new Set(expandedContent);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedContent = next;
  }

  const kwJson = (arr: string[]) => JSON.stringify(arr.map((s) => s.trim()).filter(Boolean));

  function setKeywords(next: string[]) {
    keywords = next;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const d = await get<{ data: Record<string, string> }>('/api/admin/config');
      const pick: Record<string, string> = {};
      for (const k of RULE_KEYS) pick[k] = d.data[k] ?? '';
      cfg = pick;
      saved = { ...pick };
      try {
        const parsed = JSON.parse(cfg.spamKeywords || '[]');
        keywords = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        keywords = [];
      }
      customRegex = cfg.spamCustomRegex ?? '';
    } catch (e) {
      error = msg(e);
    } finally {
      loading = false;
    }
    await loadQueue();
    await loadPatternFile();
    await loadAi();
  }

  async function loadAi() {
    try {
      const d = await get<{ data: AiStatusLite }>('/api/admin/ai/status');
      ai = d.data;
    } catch {
      // AI 状态读不到不影响规则编辑：卡片自己显示失败，别的照常
      ai = null;
    }
  }

  /** AI 审核开关即时生效：不跟规则表单一起等「保存规则」 */
  async function toggleAiModeration() {
    if (!ai || aiToggleBusy) return;
    aiToggleBusy = true;
    error = '';
    try {
      const next = !ai.moderation;
      await patch('/api/admin/config', { aiModerationEnabled: next });
      ai = { ...ai, moderation: next };
      aiProbe = null;
      notice = next ? '已开启 AI 审核（本地规则放行后才交给模型）' : '已关闭 AI 审核';
      setTimeout(() => (notice = ''), 3500);
    } catch (e) {
      error = msg(e);
    } finally {
      aiToggleBusy = false;
    }
  }

  async function loadQueue() {
    try {
      const d = await get<{ data: Cmt[] }>(`/api/admin/comments?status=${queueStatus}`);
      queue = d.data;
    } catch (e) {
      error = msg(e);
    }
  }

  async function loadPatternFile() {
    pfLoading = true;
    pfError = '';
    pfMissing = false;
    try {
      const d = await get<{ data: { path?: string; content?: string; exists?: boolean } | string }>(
        '/api/admin/spam/pattern-file',
      );
      if (typeof d.data === 'string') pfText = d.data;
      else {
        pfPath = d.data?.path ?? pfPath;
        pfText = d.data?.content ?? '';
        pfMissing = d.data?.exists === false;
      }
      pfSaved = pfText;
    } catch {
      // 接口没落地或读仓库失败：同样给一个空编辑器，保存即创建
      pfText = '';
      pfSaved = '';
      pfMissing = true;
    } finally {
      pfLoading = false;
    }
  }

  async function savePatternFile() {
    pfSaving = true;
    pfError = '';
    pfNotice = '';
    try {
      const d = await put<{ data?: { path?: string } }>('/api/admin/spam/pattern-file', { content: pfText });
      pfPath = d.data?.path ?? pfPath;
      pfSaved = pfText;
      pfNotice = `已写入仓库 ${pfPath}`;
      pfMissing = false;
      setTimeout(() => (pfNotice = ''), 3000);
    } catch (e) {
      pfError = msg(e);
    } finally {
      pfSaving = false;
    }
  }

  /** AI 复核：只处理单条，结论由后端落库，成功后刷新队列 */
  let aiBusy = $state('');
  async function aiReview(id: string) {
    aiBusy = id;
    error = '';
    try {
      const d = await post<{ data: { verdict: string; reason: string; status: string } }>(`/api/admin/comments/${id}/ai-review`);
      notice = `AI 判定：${d.data.verdict}${d.data.reason ? `（${d.data.reason}）` : ''}，状态已更新为 ${d.data.status}`;
      setTimeout(() => (notice = ''), 6000);
      await loadQueue();
    } catch (e) {
      error = msg(e);
    } finally {
      aiBusy = '';
    }
  }

  const changedKeys = $derived(
    RULE_KEYS.filter((k) => k !== 'spamKeywords' && k !== 'spamCustomRegex' && (cfg[k] ?? '') !== (saved[k] ?? '')),
  );
  const dirtyKeywords = $derived(kwJson(keywords) !== (saved.spamKeywords ?? ''));
  const dirtyCustom = $derived(customRegex !== (saved.spamCustomRegex ?? ''));
  const totalChanged = $derived(changedKeys.length + (dirtyKeywords ? 1 : 0) + (dirtyCustom ? 1 : 0));

  async function save() {
    if (!totalChanged) return;
    const count = totalChanged;
    saving = true;
    error = '';
    const payload: Record<string, string | number | boolean> = {};
    for (const k of changedKeys) {
      const raw = cfg[k] ?? '';
      if (k === 'spamEnabled' || k === 'spamHoldPending' || k === 'spamUseBuiltinPatterns') payload[k] = raw === 'true';
      else if (k === 'spamThreshold' || k === 'spamRuleWeight')
        payload[k] = raw === '' ? '' : Number(raw);
      else payload[k] = raw; // 密钥留空时不会进 changedKeys，天然不覆盖
    }
    if (dirtyKeywords) payload.spamKeywords = kwJson(keywords);
    if (dirtyCustom) payload.spamCustomRegex = customRegex;
    try {
      await patch('/api/admin/config', payload);
      await load();
      notice = `已保存 ${count} 项规则`;
      setTimeout(() => (notice = ''), 3000);
    } catch (e) {
      error = msg(e);
    } finally {
      saving = false;
    }
  }

  async function runProbe() {
    probing = true;
    error = '';
    verdict = null;
    try {
      const body: Record<string, string> = { content: probe.content };
      if (probe.name.trim()) body.authorName = probe.name.trim();
      if (probe.email.trim()) body.authorEmail = probe.email.trim();
      if (probe.link.trim()) body.authorLink = probe.link.trim();
      const d = await post<{ data: Verdict }>('/api/admin/spam/probe', body);
      verdict = d.data;
    } catch (e) {
      error = msg(e);
    } finally {
      probing = false;
    }
  }

  /** 只让 AI 判这段文字，不入库、不改任何评论状态 */
  async function runAiProbe() {
    if (!probe.content.trim() || aiProbing) return;
    aiProbing = true;
    aiProbe = null;
    error = '';
    try {
      const body: Record<string, string> = { content: probe.content };
      if (probe.name.trim()) body.authorName = probe.name.trim();
      if (probe.email.trim()) body.authorEmail = probe.email.trim();
      if (probe.link.trim()) body.authorLink = probe.link.trim();
      const d = await post<{ data: { verdict: string; reason: string } }>('/api/admin/ai/moderate', body);
      aiProbe = d.data;
    } catch (e) {
      error = msg(e);
    } finally {
      aiProbing = false;
    }
  }

  /**
   * 命中项归一化：新版 rules 是对象数组（source/pattern/label/weight），
   * 老版是字符串数组；两者都能渲染。实在没有 rules 就退回按 reason 切分。
   */
  const probeRules = $derived.by((): ProbeRule[] => {
    if (!verdict) return [];
    const raw: (string | RuleHit)[] = verdict.rules?.length
      ? verdict.rules
      : verdict.reason
        ? verdict.reason.split('；').filter(Boolean)
        : [];
    return raw.map((r, i): ProbeRule => {
      const key = `rule-${i}`;
      if (typeof r === 'string') return { key, sourceLabel: '规则', pattern: '', label: r, weight: null };
      const src = String(r?.source ?? '');
      const pattern = String(r?.pattern ?? '');
      const label = String(r?.label ?? '') || pattern;
      return {
        key,
        sourceLabel: SOURCE_LABELS[src] ?? (src || '规则'),
        pattern,
        label: label || pattern || '命中的规则',
        weight: typeof r?.weight === 'number' ? r.weight : null,
      };
    });
  });

  /** 服务商原始返回：折叠展示用，序列化失败也不能把整页打挂 */
  const providerRawText = $derived.by(() => {
    const raw = verdict?.provider?.raw;
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  });

  async function moderate(id: string, action: 'approve' | 'reject') {
    error = '';
    try {
      await post(`/api/admin/comments/${id}/moderate`, { action });
      await loadQueue();
    } catch (e) {
      error = msg(e);
    }
  }

  async function batch(action: 'approve' | 'spam') {
    const ids = queue.map((r) => r.id);
    if (!ids.length) return;
    if (!confirm(`把当前 ${ids.length} 条全部标记为${action === 'spam' ? '垃圾评论' : '正常'}？`)) return;
    error = '';
    try {
      /* 后端报的是「真的改了几条」：本来就是那个状态、或早已被删掉的都不算，
         界面别再拿请求条数冒充结果条数。 */
      const d = await post<{ data: { requested: number; handled: number } }>('/api/admin/comments/moderate-batch', { ids, action });
      await loadQueue();
      const { requested, handled } = d.data;
      notice = handled === requested ? `已处理 ${handled} 条` : `已处理 ${handled} 条，另 ${requested - handled} 条本来就是该状态或已不在队列里`;
      setTimeout(() => (notice = ''), 5000);
    } catch (e) {
      error = msg(e);
    }
  }

  function addKeyword(v: string) {
    const t = v.trim();
    if (!t || keywords.includes(t)) return;
    setKeywords([...keywords, t]);
  }

  let defaultsBusy = $state(false);

  /**
   * 把内置默认规则集复制进「自定义正则」框：复制出来的就是可编辑的一份，
   * 之后逐条删改都在自己的框里做，不必动代码，也不必维护仓库文件。
   */
  async function copyDefaultPatterns() {
    if (defaultsBusy) return;
    if (!confirm('把内置默认规则集复制进「自定义正则」框？\n\n复制后你会多出一份可逐条删改的规则；内置那份仍然受上面的总开关控制。')) return;
    defaultsBusy = true;
    error = '';
    try {
      const res = await get<{ data: { text: string; count: number } }>('/api/admin/spam/default-patterns');
      const text = res.data?.text ?? '';
      const count = res.data?.count ?? 0;
      customRegex = customRegex.trim() ? `${customRegex.replace(/\s+$/, '')}\n${text}` : text;
      notice = `已把 ${count} 条默认规则复制进输入框，点右上角「保存规则」生效`;
      setTimeout(() => (notice = ''), 4000);
    } catch (e) {
      error = msg(e);
    } finally {
      defaultsBusy = false;
    }
  }

  $effect(() => void load());
</script>

<div class="row spread head">
  <h2>评论审核</h2>
  <div class="row">
    <span class="muted small">{totalChanged ? `${totalChanged} 项未保存` : '规则已保存'}</span>
    <button class="sm" onclick={() => void load()} disabled={loading}>重新读取</button>
    <button class="primary" onclick={() => void save()} disabled={saving || !totalChanged}>{saving ? '保存中…' : '保存规则'}</button>
  </div>
</div>


<div class="cols">
  <section class="card">
    <h3>规则</h3>
    <div class="fields">
      <label class="switch">
        <input type="checkbox" checked={cfg.spamEnabled === 'true'} onchange={(e) => (cfg.spamEnabled = e.currentTarget.checked ? 'true' : 'false')} />
        <span>开启自动审核</span>
      </label>
      <label class="switch">
        <input type="checkbox" checked={cfg.spamHoldPending === 'true'} onchange={(e) => (cfg.spamHoldPending = e.currentTarget.checked ? 'true' : 'false')} />
        <span>命中是否进待审</span>
      </label>
      <p class="hint">开：命中进「待审核」。关：命中进「垃圾评论」。</p>
      <label class="switch">
        <input
          type="checkbox"
          checked={cfg.spamUseBuiltinPatterns === 'true'}
          onchange={(e) => (cfg.spamUseBuiltinPatterns = e.currentTarget.checked ? 'true' : 'false')}
        />
        <span>启用默认规则集</span>
      </label>
      <label>
        明确规则单条分值
        <input type="number" min="1" max="100" bind:value={cfg.spamRuleWeight} />
        <span class="muted hint">数值越高越严；默认 70</span>
      </label>
      <label>
        判定阈值
        <input type="number" min="1" max="100" bind:value={cfg.spamThreshold} />
        <span class="muted hint">数值越低越严；默认 60</span>
      </label>
      <label>
        链接字数占比线
        <input bind:value={cfg.spamLinkRatio} placeholder="0.5" />
        <span class="muted hint">0-1，链接文字占比超过它视为刷链</span>
      </label>
    </div>

    <h4>关键词</h4>
    <div class="chips">
      {#each keywords as k (k)}
        <button class="chip" title="点击删除" onclick={() => setKeywords(keywords.filter((x) => x !== k))}>{k} ×</button>
      {/each}
      {#if !keywords.length}<span class="muted small">还没有关键词</span>{/if}
    </div>
    <div class="row kw">
      <input placeholder="输入后回车添加" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(e.currentTarget.value); e.currentTarget.value = ''; } }} />
    </div>

    <h4>自定义正则（本机保存）</h4>
    <p class="muted small">每行一条，写成 <code>/正则/flags</code>、裸正则或普通关键词。</p>
    <div class="row">
      <button class="sm" onclick={() => void copyDefaultPatterns()} disabled={defaultsBusy}>
        {defaultsBusy ? '读取中…' : '复制内置默认规则到下面'}
      </button>
      <span class="muted small">内置那份随时可以用上面的开关整份关掉，两者同时命中会累加。</span>
    </div>
    <textarea rows="10" placeholder={'/\\d{11}/\n加\\s*好友\n(https?:)?\\/\\/t\\.me'} bind:value={customRegex}></textarea>
  </section>

  <div class="stack">
    <section class="card">
      <h4>AI 审核</h4>
      <p class="muted small">
        本地规则放行后再交给大模型复核：正常就通过，拿不准转待审核，判垃圾直接拒收。
        模型超时、报错或额度用完时维持本地判定，不会把评论区卡死。
      </p>
      {#if ai}
        <label class="switch">
          <input
            type="checkbox"
            checked={ai.moderation}
            onchange={() => void toggleAiModeration()}
            disabled={aiToggleBusy || (!ai.ready && !ai.moderation)}
          />
          <span>开启 AI 审核{aiToggleBusy ? '（保存中…）' : ''}</span>
        </label>
        <p class="small">
          服务商 <b>{ai.label}</b> · 模型 <b>{ai.model || '—'}</b>
          <span class="badge {ai.ready ? 'good' : 'pending'}">{ai.ready ? '已就绪' : '未配置'}</span>
        </p>
        {#if !ai.ready}
          <p class="warn small">
            还没配好{ai.hint ? `：${ai.hint}` : ''}。去
            <a href="/settings">「设置 → AI 模型配置」</a>
            补齐。
          </p>
        {/if}
        <p class="muted small">
          逐条复核用下面队列里的「AI 复核」；自动回复的开关与人设在 <a href="/ai">AI 回复</a> 页。
        </p>
      {:else}
        <p class="muted small">AI 状态读取失败，点右上角「重新读取」再试。</p>
      {/if}
    </section>

    <section class="card">
      <h4>外部审核服务商</h4>
      <p class="muted small">
        服务商只做加法：它说垃圾才算加到分上，异常或超时 fail-open。这里只选服务商；
        Endpoint 与密钥在
        <a href="/settings">「设置 → 评论审核服务商」</a>
        填。
      </p>
      <div class="fields">
        <label>
          服务商类型
          <select bind:value={cfg.spamProviderKind}>
            {#each PROVIDER_KINDS as [v, label] (v)}
              <option value={v}>{label}</option>
            {/each}
          </select>
        </label>
      </div>
    </section>

    <details class="card repo-file">
      <summary><span>仓库规则文件（高级）</span>{#if pfPath}<code>{pfPath}</code>{/if}</summary>
      <p class="muted small">
        和上面的「自定义正则」二选一即可：这一份会提交进内容仓库，随站点走，适合多台设备/多人共享；
        日常改规则用上面那个就够了。
      </p>
      <p class="muted small">
        站点仓库里那份共享正则清单，落在仓库根的 <code>.zero/spam-patterns.txt</code>，读写走
        <code>GET / PUT /api/admin/spam/pattern-file</code>。别把它挪进 <code>data/</code>：
        Hugo 会把 <code>data/</code> 下任何未知扩展名都当数据文件解析，那份文件一进去整站构建就报
        <code>unmarshal of format "" is not supported</code>。
      </p>
      {#if pfLoading}
        <p class="muted small">读取中…</p>
      {:else}
        {#if pfMissing}<p class="warn small">文件不存在或接口未落地——保存即创建。</p>{/if}
        <textarea rows="7" placeholder={'每行一条正则，可带注释行 #'} bind:value={pfText}></textarea>
      {/if}
      {#if pfError}<p class="err">{pfError}</p>{/if}
      {#if pfNotice}<p class="ok">{pfNotice}</p>{/if}
      <div class="row">
        <button class="sm" onclick={() => void loadPatternFile()} disabled={pfLoading}>重载</button>
        <button class="primary" onclick={() => void savePatternFile()} disabled={pfSaving || pfText === pfSaved}>{pfSaving ? '写入中…' : '写入文件'}</button>
      </div>
    </details>
  </div>
</div>

<section class="card probe">
  <h3>试跑一段文本</h3>
  <p class="muted small">用当前规则打分，不会写入数据库，调阈值时对着看。</p>
  <textarea rows="4" placeholder="把可疑评论贴进来" bind:value={probe.content}></textarea>
  <div class="fields tight">
    <label>昵称<input bind:value={probe.name} /></label>
    <label>邮箱<input bind:value={probe.email} /></label>
    <label>作者链接<input bind:value={probe.link} /></label>
  </div>
  <div class="row">
    <button class="primary" onclick={() => void runProbe()} disabled={probing || !probe.content.trim()}>{probing ? '打分中…' : '试跑'}</button>
    <button onclick={() => void runAiProbe()} disabled={aiProbing || !probe.content.trim() || !ai?.ready}>
      {aiProbing ? 'AI 判断中…' : 'AI 判一下'}
    </button>
    {#if !ai?.ready}<span class="muted small">AI 未配置，去设置里选服务商并填密钥</span>{/if}
  </div>

  {#if aiProbe}
    <div class="verdict {aiProbe.verdict === 'approve' ? 'good' : 'bad'}">
      <div class="grow1">
        <p class="strong">
          AI 判定：{aiProbe.verdict === 'approve' ? '正常' : aiProbe.verdict === 'spam' ? '垃圾' : '转人工待审'}
        </p>
        <p class="muted small">{aiProbe.reason || '模型没有给出理由'}</p>
        <p class="muted small">这里只试判、不改任何评论；正式拦截看上面的「开启 AI 审核」。</p>
      </div>
    </div>
  {/if}

  {#if verdict}
    <div class="verdict {verdict.spam ? 'bad' : 'good'}">
      <div class="big">{verdict.score}<span class="muted">/100</span></div>
      <div class="grow1">
        <p class="strong">{verdict.spam ? '判定：垃圾评论' : '判定：正常'}</p>
        {#if probeRules.length}
          <p class="muted small">命中的规则：</p>
          <ul class="rules">
            {#each probeRules as rule (rule.key)}
              <li>
                {#if rule.sourceLabel}<span class="tag">{rule.sourceLabel}</span>{/if}
                <span>{rule.label}</span>
                {#if rule.pattern && rule.pattern !== rule.label}<code class="pat">{rule.pattern}</code>{/if}
                {#if rule.weight != null}<span class="muted weight">+{rule.weight}</span>{/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted small">没有命中任何规则</p>
        {/if}
        <p class="muted small">{verdict.hold ? '命中后会先扣住等人工' : '命中后直接标记，仍会显示'}</p>

        {#if verdict.provider}
          <div class="provider">
            <div class="prow">
              <span class="tag">服务商</span>
              <span class="small strong">{verdict.provider.kind || '—'}</span>
              <span class="pill {verdict.provider.ok ? 'good' : 'bad'}">
                {verdict.provider.ok ? '调用成功' : '调用失败'}
              </span>
              <span class="small">{verdict.provider.label || '无返回说明'}</span>
            </div>
            {#if verdict.provider.error}<p class="err small">服务商报错：{verdict.provider.error}</p>{/if}
            {#if providerRawText}
              <details class="raw">
                <summary class="muted small">服务商原始返回</summary>
                <pre>{providerRawText}</pre>
              </details>
            {/if}
          </div>
        {:else}
          <p class="muted small">未启用外部服务商，或后端试跑接口尚未回传 provider 字段。</p>
        {/if}
      </div>
    </div>
  {/if}
</section>

<section class="card queue">
  <div class="row spread">
    <h3>待处理队列</h3>
    <div class="row">
      <button class="sm" class:on={queueStatus === 'spam'} onclick={() => { queueStatus = 'spam'; void loadQueue(); }}>已判垃圾</button>
      <button class="sm" class:on={queueStatus === 'pending'} onclick={() => { queueStatus = 'pending'; void loadQueue(); }}>待审核</button>
      {#if queue.length}
        <button class="sm" onclick={() => void batch('approve')}>全部放行</button>
        {#if queueStatus === 'pending'}<button class="sm danger" onclick={() => void batch('spam')}>全部判垃圾</button>{/if}
      {/if}
    </div>
  </div>

  {#if queue.length === 0}
    <p class="muted small">这个队列是空的。</p>
  {:else}
    <div class="table-wrap">
      <table class="cols-wide">
        <thead>
          <tr>
            <th>作者</th>
            <th>邮箱</th>
            <th>内容</th>
            <th>位置</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each queue as r (r.id)}
            <tr>
              <td class="author">{r.authorName}</td>
              <td class="email">{r.authorEmail || '—'}</td>
              <td class="content-cell" class:open={expandedContent.has(r.id)}>
                <div class="clip">{@html renderMarkdown(r.content, { shortBase: frontUrl('/posts/') || '/posts/' })}</div>
                <button class="sm ghost more" type="button" onclick={() => toggleContent(r.id)}>{expandedContent.has(r.id) ? '收起' : '展开'}</button>
              </td>
              <td class="place">
                {#if frontUrl(r.postSlug)}
                  <a href={frontUrl(r.postSlug)} target="_blank" rel="noreferrer" title={r.postTitle || r.postSlug}>{r.postTitle || r.postSlug}</a>
                {:else}
                  <span class="muted" title={r.postTitle || r.postSlug}>{r.postTitle || r.postSlug}</span>
                {/if}
                {#if r.postTitle}<div class="muted small" title={r.postSlug}>{r.postSlug}</div>{/if}
              </td>
              <td class="time">{timeAgo(r.createdAt)}</td>
              <td class="ops">
                <button class="sm" onclick={() => void moderate(r.id, 'approve')}>放行</button>
                <button class="sm" onclick={() => void aiReview(r.id)} disabled={aiBusy === r.id}>
                  {aiBusy === r.id ? '复核中…' : 'AI 复核'}
                </button>
                <button class="sm danger" onclick={() => void moderate(r.id, 'reject')}>删除</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .head {
    margin-bottom: 0.5rem;
  }
  .small {
    font-size: 0.76rem;
  }
  .cols {
    display: grid;
    grid-template-columns: var(--t-3);
    gap: 0.8rem;
    align-items: start;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  .fields {
    display: grid;
    grid-template-columns: var(--t-4);
    gap: 0.6rem 0.8rem;
    margin: 0.5rem 0;
    align-items: start;
  }
  .fields label > input:not([type='checkbox']):not([type='radio']),
  .fields label > select {
    width: 100%;
    height: var(--ctl-h);
  }
  .fields > label.switch,
  .fields > p.hint {
    grid-column: 1 / -1;
  }
  .fields > p.hint {
    margin: 0;
  }
  .fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .fields.tight {
    margin-top: 0.4rem;
    grid-template-columns: var(--t-6);
  }
  .hint {
    font-size: 0.72rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    color: var(--fg);
  }
  h4 {
    margin: 0.9rem 0 0.3rem;
    font-size: 0.88rem;
  }
  .card h4:first-child {
    margin-top: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .chip {
    padding: 0.1rem 0.55rem;
    font-size: 0.78rem;
    border-radius: 999px;
    background: var(--bad-soft);
    border-color: var(--bad-border);
    color: var(--bad);
  }
  .kw input {
    flex: 1;
  }
  textarea {
    width: 100%;
    margin-top: 0.3rem;
  }
  .card .row {
    margin-top: 0.5rem;
  }
  .probe {
    margin-top: 0.9rem;
  }
  .verdict {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    margin-top: 0.9rem;
    padding: 0.7rem 0.9rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }
  .verdict.bad {
    background: var(--bad-soft);
    border-color: var(--bad-border);
  }
  .verdict.good {
    background: var(--good-soft);
    border-color: var(--good-border);
  }
  .verdict .big {
    font-size: 1.7rem;
    font-weight: 700;
    min-width: 74px;
  }
  .verdict .grow1 {
    flex: 1;
    min-width: 0;
  }
  .strong {
    margin: 0 0 0.2rem;
    font-weight: 650;
  }
  .rules {
    margin: 0.1rem 0 0.3rem;
    padding-left: 1.1rem;
    font-size: 0.8rem;
  }
  .rules li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    margin: 0.12rem 0;
  }
  .tag {
    padding: 0.02rem 0.42rem;
    font-size: 0.7rem;
    border-radius: 999px;
    background: var(--accent-soft);
    border: 1px solid var(--border-strong);
    color: var(--accent);
    white-space: nowrap;
  }
  .pat {
    font-size: 0.72rem;
    color: var(--muted);
    background: var(--panel-2);
    border-radius: 4px;
    padding: 0 0.25rem;
    word-break: break-all;
  }
  .weight {
    font-size: 0.72rem;
    white-space: nowrap;
  }
  .provider {
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px dashed var(--border);
  }
  .provider .prow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
  }
  .pill {
    padding: 0.02rem 0.42rem;
    font-size: 0.72rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .pill.good {
    background: var(--good-soft);
    border-color: var(--good-border);
    color: var(--good);
  }
  .pill.bad {
    background: var(--bad-soft);
    border-color: var(--bad-border);
    color: var(--bad);
  }
  .raw {
    margin-top: 0.3rem;
  }
  .raw pre {
    margin: 0.3rem 0 0;
    padding: 0.4rem 0.5rem;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.72rem;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .queue {
    margin-top: 0.9rem;
  }
  .repo-file {
    padding: 0.85rem 1rem;
  }
  .repo-file > summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    list-style: none;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .repo-file > summary::-webkit-details-marker {
    display: none;
  }
  .repo-file > summary::before {
    content: '▸';
    color: var(--muted);
    font-weight: 400;
  }
  .repo-file[open] > summary::before {
    content: '▾';
  }
  .repo-file > summary code {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.72rem;
    font-weight: 400;
    color: var(--muted);
  }
  .repo-file[open] > summary {
    margin-bottom: 0.5rem;
  }
  .queue table {
    table-layout: fixed;
    min-width: 940px;
  }
  .queue th:nth-child(1) { width: 120px; }
  .queue th:nth-child(2) { width: 170px; }
  .queue th:nth-child(4) { width: 170px; }
  .queue th:nth-child(5) { width: 84px; }
  .queue th:nth-child(6) { width: 190px; }
  .queue td.author,
  .queue td.email,
  .queue td.time {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .queue td.place a,
  .queue td.place .muted {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .queue td.content-cell .clip {
    max-width: 320px;
  }
  .queue td.content-cell.open .clip {
    max-width: none;
    white-space: normal;
  }
  .queue td.content-cell .more {
    margin-top: 2px;
    padding: 0 0.35rem;
    min-height: 22px;
    font-size: 0.72rem;
  }
  .queue td.content-cell .clip :global(p) {
    margin: 0;
  }
  .queue td.content-cell.open .clip :global(p) {
    margin: 0.25rem 0;
    white-space: normal;
  }
  .queue .on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
  .clip {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 这一列现在装的是渲染后的 HTML：段落收成 inline 才仍然单行截断，
     表情图跟着行高走，别把整行撑高 */
  .clip :global(p) {
    display: inline;
    margin: 0;
  }
  .clip :global(img.zc-emoji-img) {
    display: inline-block; height: 1.4em; width: auto; max-width: 1.4em;
    vertical-align: -0.3em; margin: 0 0.05em;
  }
  .ops {
    white-space: nowrap;
  }
  .ops button + button {
    margin-left: 0.3rem;
  }
  /* 手机/小屏：两列字段表收成一列 */
  @media (max-width: 900px) {
    .fields {
      grid-template-columns: 1fr;
    }
  }
</style>
