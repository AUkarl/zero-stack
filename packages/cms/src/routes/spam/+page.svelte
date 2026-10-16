<script lang="ts">
  import { get, patch, post, put } from '#lib/api';
  import { timeAgo } from '#lib/api';
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
    ['aliyun', '阿里云内容安全'],
    ['tencent', '腾讯云天御'],
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
    'spamMinWords',
    'spamMaxUrls',
    'spamLinkRatio',
    'spamKeywords',
    'spamCustomRegex',
    'spamProviderKind',
    'spamProviderEndpoint',
    'spamProviderKeyId',
    'spamProviderSecret',
  ] as const;

  let cfg = $state<Record<string, string>>({});
  let saved = $state<Record<string, string>>({});
  let hasSecret = $state<Record<string, boolean>>({});
  let keywords = $state<string[]>([]);
  let customRegex = $state('');
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');

  // 仓库正则文件 data/spam-patterns.txt
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

  // 队列
  let queue = $state<Cmt[]>([]);
  let queueStatus = $state<'spam' | 'pending'>('spam');

  const kwJson = (arr: string[]) => JSON.stringify(arr.map((s) => s.trim()).filter(Boolean));

  function setKeywords(next: string[]) {
    keywords = next;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const d = await get<{ data: Record<string, string>; hasSecret?: Record<string, boolean> }>('/api/admin/config');
      const pick: Record<string, string> = {};
      for (const k of RULE_KEYS) pick[k] = d.data[k] ?? '';
      cfg = pick;
      saved = { ...pick };
      hasSecret = d.hasSecret ?? {};
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
      const d = await get<{ data: { content: string } | string }>('/api/admin/spam/pattern-file');
      const text = typeof d.data === 'string' ? d.data : d.data?.content ?? '';
      pfText = text;
      pfSaved = text;
    } catch {
      // 文件不存在 / 接口未落地：给一个空编辑器，保存即创建
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
      await put('/api/admin/spam/pattern-file', { content: pfText });
      pfSaved = pfText;
      pfNotice = '已写入仓库 data/spam-patterns.txt';
      pfMissing = false;
      setTimeout(() => (pfNotice = ''), 3000);
    } catch (e) {
      pfError = msg(e);
    } finally {
      pfSaving = false;
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
      else if (k === 'spamThreshold' || k === 'spamMinWords' || k === 'spamMaxUrls' || k === 'spamRuleWeight')
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
      await post('/api/admin/comments/moderate-batch', { ids, action });
      await loadQueue();
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

<p class="muted small">
  评论入库前按下面的规则打分（0-100），分数达到阈值即判为垃圾评论。登录用户的阈值自动 +20，作者越可信越宽松。
</p>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

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
        <span>命中后先进「待审核」而不是「垃圾评论」</span>
      </label>
      <p class="hint">
        关（默认）：命中规则直接标为垃圾，进「垃圾评论」队列，不再占你的待审核。打开：命中的先压进「待审核」，
        由你决定放行还是判杀。站长与管理员本人的评论两种情况下都不扫描。
      </p>
      <label class="switch">
        <input
          type="checkbox"
          checked={cfg.spamUseBuiltinPatterns === 'true'}
          onchange={(e) => (cfg.spamUseBuiltinPatterns = e.currentTarget.checked ? 'true' : 'false')}
        />
        <span>启用内置默认规则集（赌博 / 色情 / 诈骗 / 违法物品 / 广告导流 / 英文垃圾）</span>
      </label>
      <label>
        明确规则单条分值
        <input type="number" min="1" max="100" bind:value={cfg.spamRuleWeight} />
        <span class="muted hint">
          默认 70。关键词、内置默认规则集、下面的自定义正则、仓库规则文件命中时各加这么多分 ——
          高于判定阈值就意味着「你写了这条，命中就一定拦下来」；改小它才需要多条同时命中才拦。
        </span>
      </label>
      <label>
        判定阈值
        <input type="number" min="1" max="100" bind:value={cfg.spamThreshold} />
        <span class="muted hint">默认 60，越小越严格</span>
      </label>
      <label>
        最少字数
        <input type="number" min="0" bind:value={cfg.spamMinWords} />
        <span class="muted hint">短于该字数加分，默认 2</span>
      </label>
      <label>
        最多外链数
        <input type="number" min="0" bind:value={cfg.spamMaxUrls} />
        <span class="muted hint">超过即加分，默认 3</span>
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

    <h4>自定义正则</h4>
    <p class="muted small">
      每行一条，写成 <code>/正则/flags</code>、裸正则或普通关键词；一条命中的分值就是上面的「明确规则单条分值」（默认 70，一条即过阈值）。
      保存进配置键 <code>spamCustomRegex</code>。匹配前会先归一化：全角转半角、去零宽字符、压掉中文之间的空格，
      所以「加 微 信」「加ＶＸ」这类拆字写法同样命中。
    </p>
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
      <h4>外部审核服务商</h4>
      <p class="muted small">
        服务商只做加法：它说垃圾才算加到分上，异常或超时 fail-open。密钥字段读取时显示「已设置」，留空即保持原值不变。
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
        <label class="full">
          Endpoint
          <input bind:value={cfg.spamProviderEndpoint} placeholder="https://…/check" />
        </label>
        <label>
          KeyId / AccessKey
          <input type="password" bind:value={cfg.spamProviderKeyId} placeholder={hasSecret.spamProviderKeyId ? '已设置，留空不改' : '选填'} />
          {#if hasSecret.spamProviderKeyId}<span class="ok hint">已设置</span>{/if}
        </label>
        <label>
          Secret
          <input type="password" bind:value={cfg.spamProviderSecret} placeholder={hasSecret.spamProviderSecret ? '已设置，留空不改' : '选填'} />
          {#if hasSecret.spamProviderSecret}<span class="ok hint">已设置</span>{/if}
        </label>
      </div>
    </section>

    <section class="card">
      <h4>仓库正则文件 data/spam-patterns.txt</h4>
      <p class="muted small">站点仓库里那份共享正则清单，读写走 <code>GET / PUT /api/admin/spam/pattern-file</code>。</p>
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
    </section>
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
  <div class="row"><button class="primary" onclick={() => void runProbe()} disabled={probing || !probe.content.trim()}>{probing ? '打分中…' : '试跑'}</button></div>

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
            <th>内容</th>
            <th>位置</th>
            <th>分数</th>
            <th>命中原因</th>
            <th>时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each queue as r (r.id)}
            <tr>
              <td>{r.authorName}{r.authorEmail ? ` 〈${r.authorEmail}〉` : ''}</td>
              <td class="clip">{r.content}</td>
              <td>
                {#if frontUrl(r.postSlug)}
                  <a href={frontUrl(r.postSlug)} target="_blank" rel="noreferrer">{r.postSlug}</a>
                {:else}
                  <span class="muted">{r.postSlug}</span>
                {/if}
              </td>
              <td>{r.spamScore ?? '—'}</td>
              <td class="clip">{r.spamReason || '—'}</td>
              <td>{timeAgo(r.createdAt)}</td>
              <td class="ops">
                <button class="sm" onclick={() => void moderate(r.id, 'approve')}>放行</button>
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
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
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
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.6rem;
    margin: 0.5rem 0;
  }
  .fields.tight {
    margin-top: 0.4rem;
  }
  .fields .full {
    grid-column: 1 / -1;
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
    background: #fef2f2;
    border-color: #fecaca;
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
    background: #fef2f2;
    border-color: #fecaca;
  }
  .verdict.good {
    background: #f0fdf4;
    border-color: #bbf7d0;
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
    background: #eef2ff;
    border: 1px solid #c7d2fe;
    color: #3730a3;
    white-space: nowrap;
  }
  .pat {
    font-size: 0.72rem;
    color: var(--muted);
    background: #f3f4f6;
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
    background: #f0fdf4;
    border-color: #bbf7d0;
    color: var(--good);
  }
  .pill.bad {
    background: #fef2f2;
    border-color: #fecaca;
    color: var(--bad);
  }
  .raw {
    margin-top: 0.3rem;
  }
  .raw pre {
    margin: 0.3rem 0 0;
    padding: 0.4rem 0.5rem;
    background: #f8fafc;
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
  .queue .on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .clip {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ops {
    white-space: nowrap;
  }
  .ops button + button {
    margin-left: 0.3rem;
  }
</style>
