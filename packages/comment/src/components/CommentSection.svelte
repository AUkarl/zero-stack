<svelte:options
  customElement={{
    tag: 'zero-comment',
    props: {
      apiBase: { attribute: 'api-base', type: 'String' },
      postSlug: { attribute: 'post-slug', type: 'String' },
      shortBase: { attribute: 'short-base', type: 'String' },
      loginHref: { attribute: 'login-href', type: 'String' },
      collapsed: { attribute: 'collapsed', type: 'Boolean' },
      lang: { attribute: 'lang', type: 'String' },
    },
  }}
/>
<script lang="ts">
  import type { Comment, CommentListData, CommentPostData, SortKey } from './types';
  import CommentEditor from './CommentEditor.svelte';
  import CommentNode from './CommentNode.svelte';
  import { apiFetch, canonSlug, resolveBase } from '../lib/api';
  import { commentConfig } from '../lib/config.svelte';
  import { emojiPacks } from '../lib/emoji-packs';
  import { tr } from '../lib/i18n';
  import { dropOwnerKey, ownerKeyOf, ownersParam, saveOwnerKey } from '../lib/owners';
  import { session } from '../lib/session.svelte';
  import { hostAccent, hostTheme } from '../lib/theme.svelte';

  let {
    apiBase = '',
    postSlug = '',
    shortBase = '/post/',
    loginHref = '/account/',
    collapsed = false,
    lang = '',
  }: {
    apiBase?: string;
    postSlug?: string;
    shortBase?: string;
    /** 登录入口跳转的站点页面，站点在子路径下时由主题覆盖 */
    loginHref?: string;
    collapsed?: boolean;
    lang?: string;
  } = $props();

  const base = $derived(resolveBase(apiBase));
  /** post-slug 没给就退回当前路径；两种写法都归一到 canonSlug，ownerKey 的分组键才不会分裂 */
  const key = $derived(canonSlug(postSlug || (typeof document !== 'undefined' ? location.pathname : '/')));
  const effectiveLang = $derived(lang || (typeof document !== 'undefined' ? document.documentElement.lang : '') || 'zh-CN');
  const t = $derived(tr(effectiveLang));
  const noApiBase = $derived(t('noApiBase'));
  const showMeta = $derived(commentConfig.showMeta);
  const likeEnabled = $derived(commentConfig.likeEnabled);
  /** 内置四组 + 后台 commentEmojiPacks 追加的「自定义」那组 */
  const packs = $derived(emojiPacks(commentConfig.customEmojis));

  /** 后端按「顶层评论」分页：默认 20 条顶层 + 其全部平铺回复（与 api 的 DEFAULT_PAGE 对齐） */
  const PAGE = 20;
  /** 单个顶层的回复超过这个数就折叠，点一次「展开更多」再加这么多条 */
  const REPLY_PAGE = 10;

  let tree = $state<Comment[]>([]);
  /** 分页窗口外的「我自己的待审」，后端单独放在 data.mine 里 */
  let mineList = $state<Comment[]>([]);
  let meta = $state<Omit<CommentListData, 'comments' | 'mine'> | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let listError = $state('');
  let sort = $state<SortKey>('latest');
  /** 每个顶层已经展开多少条回复（按 root id 记，纯前端切片，不会再发请求） */
  let shown = $state<Record<string, number>>({});

  /* 游客身份本地留存，下次自动回填 */
  const ID_KEY = 'zero-comment-identity';
  function savedIdentity(): { name: string; email: string; link: string } {
    try {
      const raw = JSON.parse(localStorage.getItem(ID_KEY) || '{}') as Record<string, unknown>;
      return { name: String(raw.name ?? ''), email: String(raw.email ?? ''), link: String(raw.link ?? '') };
    } catch {
      return { name: '', email: '', link: '' };
    }
  }
  let guestName = $state(savedIdentity().name);
  let guestEmail = $state(savedIdentity().email);
  let guestLink = $state(savedIdentity().link);
  let mainDraft = $state('');
  let mainError = $state('');
  let mainSubmitting = $state(false);
  let doneMessage = $state('');

  async function load(
    reset: boolean,
    currentSort: SortKey,
    opts: { limit?: number; offset?: number } = {},
  ) {
    reset ? (loading = true) : (loadingMore = true);
    if (reset) shown = {};
    const offset = opts.offset ?? (reset ? 0 : tree.length);
    const limit = opts.limit ?? PAGE;
    try {
      /* depth=1：同一线程的回复全部走平铺的 replies 数组，服务端不用再嵌套 */
      const q = new URLSearchParams({
        depth: '1',
        sort: currentSort,
        offset: String(offset),
        limit: String(limit),
      });
      /* 带上本地存的凭证，自己那条待审评论才会回传（后端 parseOwners 认 JSON 对象）。
         优先走请求头 —— 查询串会留在浏览器历史与代理日志里，而这一份是「整篇文章的凭证集合」。
         但一个头不能无限长：localStorage 那侧每篇最多存 200 条，编码后能到十几 KB，
         超过 4KB 就退回查询串（服务端三档都认，退回不影响功能，只是少一次留痕改进）。 */
      const owners = ownersParam(key);
      const ownerHeaders: Record<string, string> = {};
      if (owners) {
        if (owners.length <= 4096) ownerHeaders['X-Comment-Owners'] = owners;
        else q.set('owners', owners);
      }
      const d = await apiFetch<{ data: CommentListData }>(base, `/api/comments${key}?${q}`, { headers: ownerHeaders });
      const rows = (d.data.comments ?? []).map(normalizeRoot);
      tree = reset ? rows : [...tree, ...rows];
      const extra = (d.data.mine ?? []).map(normalizeRoot);
      mineList = extra.filter((m) => !findNode(m.id));
      meta = {
        total: Number(d.data.total ?? 0),
        threadTotal: Number(d.data.threadTotal ?? 0),
        offset: Number(d.data.offset ?? offset),
        limit: Number(d.data.limit ?? limit),
        sort: d.data.sort ?? currentSort,
        hasMore: Boolean(d.data.hasMore),
        maxDepth: Number(d.data.maxDepth ?? 6),
        depth: Number(d.data.depth ?? 1),
        commentEnabled: d.data.commentEnabled !== false,
        requireReview: !!d.data.requireReview,
        allowAnonymous: d.data.allowAnonymous !== false,
      };
      listError = '';
    } catch (e) {
      listError = e instanceof Error ? e.message : t('loadFailed');
    } finally {
      loading = loadingMore = false;
    }
  }

  /** 后端理论上一定会给 replies 数组，这里只兜网络/旧版本返回缺字段的情况 */
  function normalizeRoot(c: Comment): Comment {
    return { ...c, replies: c.replies ?? [], children: [], collapsed: false, replyCount: (c.replies ?? []).length };
  }

  function setSort(next: SortKey) {
    if (sort === next) return;
    sort = next;
  }

  /* ------------------------------------------------------------------
   * 回复折叠：纯前端切片
   * ----------------------------------------------------------------*/

  const shownOf = (root: Comment) => shown[root.id] ?? REPLY_PAGE;
  const visibleReplies = (root: Comment) => (root.replies ?? []).slice(0, shownOf(root));
  const hiddenReplies = (root: Comment) => Math.max(0, (root.replies ?? []).length - shownOf(root));

  function expandReplies(root: Comment) {
    shown[root.id] = shownOf(root) + REPLY_PAGE;
  }

  /* ------------------------------------------------------------------
   * 本地列表操作：提交/删除都先改本地，不再整树重拉
   * ----------------------------------------------------------------*/

  function findNode(id: string): Comment | null {
    for (const root of tree) {
      if (root.id === id) return root;
      const hit = (root.replies ?? []).find((r) => r.id === id);
      if (hit) return hit;
    }
    return mineList.find((m) => m.id === id) ?? null;
  }

  /** 某条平铺回复所属的顶层：root_id 命中优先，退回「谁的 replies 里有它」 */
  function ownerRoot(id: string): Comment | null {
    for (const root of tree) {
      if (root.id === id) return root;
      if ((root.replies ?? []).some((r) => r.id === id)) return root;
    }
    return null;
  }

  /** 一条评论连同它下面的所有后代（平铺数组里靠 parentId 串起来） */
  function subtreeIds(list: Comment[], id: string): Set<string> {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of list) {
        if (r.parentId && out.has(r.parentId) && !out.has(r.id)) {
          out.add(r.id);
          grew = true;
        }
      }
    }
    return out;
  }

  function bumpTotal(delta: number, rootsDelta = 0) {
    if (!meta) return;
    meta = {
      ...meta,
      total: Math.max(0, meta.total + delta),
      threadTotal: Math.max(0, meta.threadTotal + rootsDelta),
    };
  }

  function insertLocal(c: Comment): boolean {
    const node: Comment = { ...c, replies: [], children: [], collapsed: false, replyCount: 0 };
    if (node.parentId) {
      const root = ownerRoot(node.rootId ?? '') ?? ownerRoot(node.parentId) ?? (tree.find((r) => r.id === node.parentId) ?? null);
      if (!root) return false;
      root.replies = [...(root.replies ?? []), node];
      root.replyCount = root.replies.length;
      // 让自己刚发的那条一定看得见：把这条线程的切片放到能覆盖末尾
      if (hiddenReplies(root) > 0) shown[root.id] = root.replies.length;
      bumpTotal(1);
      return true;
    }
    tree = sort === 'latest' ? [node, ...tree] : [...tree, node];
    bumpTotal(1, 1);
    return true;
  }

  function removeLocal(id: string) {
    const at = tree.findIndex((n) => n.id === id);
    if (at >= 0) {
      const gone = tree[at]!;
      tree = tree.filter((_, i) => i !== at);
      bumpTotal(-(1 + (gone.replies ?? []).length), -1);
      return;
    }
    const mineAt = mineList.findIndex((n) => n.id === id);
    if (mineAt >= 0) {
      mineList = mineList.filter((_, i) => i !== mineAt);
      bumpTotal(-1);
      return;
    }
    for (const root of tree) {
      const list = root.replies ?? [];
      if (!list.some((r) => r.id === id)) continue;
      const gone = subtreeIds(list, id);
      root.replies = list.filter((r) => !gone.has(r.id));
      root.replyCount = root.replies.length;
      bumpTotal(-gone.size);
      return;
    }
  }

  /** 邮箱是游客唯一必填项：昵称留空后端会按邮箱自动生成 */
  function guestEmailMissing(): boolean {
    return !session.user && !guestEmail.trim();
  }

  async function submit(parentId: string | null) {
    const draft = parentId ? ctx.draft : mainDraft;
    if (!draft.trim()) return;
    if (guestEmailMissing()) {
      const msg = t('emailRequired');
      if (parentId) ctx.error = msg;
      else mainError = msg;
      return;
    }
    mainSubmitting = ctx.submitting = true;
    mainError = ctx.error = '';
    doneMessage = '';
    try {
      const guest = !session.user;
      if (guest) localStorage.setItem(ID_KEY, JSON.stringify({ name: guestName, email: guestEmail, link: guestLink }));
      const d = await apiFetch<{ data: CommentPostData }>(base, '/api/comments', {
        method: 'POST',
        body: JSON.stringify({
          postSlug: key,
          content: draft,
          parentId: parentId ?? undefined,
          // 昵称/网址选填，登录后这三项一律由账号身份覆盖
          name: guest ? guestName.trim() || undefined : undefined,
          email: guest ? guestEmail.trim() || undefined : undefined,
          link: guest ? guestLink.trim() || undefined : undefined,
        }),
      });
      // 匿名评论的自改/自删凭证：按文章分组存 localStorage，下次取列表带 ?owners=
      if (d.data.ownerKey && d.data.id) saveOwnerKey(key, d.data.id, d.data.ownerKey);
      if (parentId) {
        ctx.replyingId = null;
        ctx.draft = '';
      } else {
        mainDraft = '';
      }
      // 待审也先本地插进去（带「审核中」角标），不整树重拉；插不进去（父评论不在本页）才重拉
      const created = d.data.comment;
      const placed = created?.id ? insertLocal(created) : false;
      if (!placed) await load(true, sort);
      doneMessage =
        d.data.status === 'pending' ? t('pendingMsg') : d.data.status === 'spam' ? d.data.message || t('pendingMsg') : t('posted');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('loadFailed');
      if (parentId) ctx.error = msg;
      else mainError = msg;
    } finally {
      mainSubmitting = ctx.submitting = false;
    }
  }

  async function saveEdit(id: string) {
    const content = ctx.editDraft;
    if (!content.trim()) return;
    ctx.editBusy = true;
    ctx.editError = '';
    try {
      const owner = ownerKeyOf(key, id);
      /* 凭证走请求头，不再挤进 URL（URL 会留在浏览器历史、代理日志和任何记录完整地址的地方）。
         body.ownerKey 照旧带着：那是服务端三档里的最后一档，老 Worker 也认。
         **升级顺序**：要先部署 Worker（allowHeaders 里有这两个头），再抬主题里的组件产物 ——
         反过来时新产物对老 Worker 发自定义头会被预检拦住。 */
      const d = await apiFetch<{ data: { id: string; content: string; status: string; editedAt: number | null; message?: string | null } }>(
        base,
        `/api/comments/${id}`,
        { method: 'PATCH', headers: owner ? { 'X-Comment-Owner': owner } : {}, body: JSON.stringify({ content, ...(owner ? { ownerKey: owner } : {}) }) },
      );
      const node = findNode(id);
      if (node) {
        node.content = d.data.content ?? content.trim();
        node.editedAt = d.data.editedAt ?? Math.floor(Date.now() / 1000);
        if (d.data.status) node.status = d.data.status;
      }
      // 改完被打回待审 / 判垃圾时后端会给一句说明，不显示出来人就以为改动丢了
      if (d.data.message) doneMessage = d.data.message;
      ctx.editingId = null;
      ctx.editDraft = '';
    } catch (e) {
      ctx.editError = e instanceof Error ? e.message : t('loadFailed');
    } finally {
      ctx.editBusy = false;
    }
  }

  async function remove(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    const owner = ownerKeyOf(key, id);
    try {
      /* 与 saveEdit 同一个口径：凭证走头，URL 里不再留痕（升级顺序见 saveEdit 那段注释） */
      await apiFetch(base, `/api/comments/${id}`, { method: 'DELETE', headers: owner ? { 'X-Comment-Owner': owner } : {} });
      dropOwnerKey(key, id);
      removeLocal(id);
      listError = '';
    } catch (e) {
      listError = e instanceof Error ? e.message : t('loadFailed');
    }
  }

  /** 点赞：POST /api/comments/:id/like 是 toggle，返回 liked / likeCount 直接写回本地节点 */
  async function like(node: Comment) {
    const d = await apiFetch<{ data: { id: string; liked: boolean; likeCount: number } }>(
      base,
      `/api/comments/${node.id}/like`,
      { method: 'POST' },
    );
    node.liked = Boolean(d.data.liked);
    node.likeCount = Number(d.data.likeCount ?? 0);
  }

  const ctx = $state({
    replyingId: null as string | null,
    draft: '',
    submitting: false,
    error: '',
    editingId: null as string | null,
    editDraft: '',
    editError: '',
    editBusy: false,
    replyTo(id: string) {
      ctx.replyingId = id;
      ctx.editingId = null;
      ctx.draft = '';
      ctx.error = '';
    },
    cancelReply() {
      ctx.replyingId = null;
      ctx.error = '';
      ctx.draft = '';
    },
    submitReply(id: string) {
      void submit(id);
    },
    startEdit(node: Comment) {
      ctx.editingId = node.id;
      ctx.editDraft = node.content;
      ctx.editError = '';
      ctx.replyingId = null;
    },
    cancelEdit() {
      ctx.editingId = null;
      ctx.editDraft = '';
      ctx.editError = '';
    },
    saveEdit(id: string) {
      void saveEdit(id);
    },
    remove(id: string) {
      void remove(id);
    },
    like(node: Comment) {
      return like(node);
    },
  });

  $effect(() => {
    session.init(base);
    void commentConfig.load(base);
    hostTheme.watch();
  });

  /* base / 文章 / 排序任一变了就重新拉第一页（load 内部只读参数，不读这些 state） */
  $effect(() => {
    const b = base;
    const s = sort;
    const k = key;
    if (!b || k === '') {
      if (!b) listError = noApiBase;
      loading = false;
      return;
    }
    void s;
    void k;
    void load(true, s);
  });

  $effect(() => {
    const b = base;
    const onAuth = () => {
      if (b) void load(true, sort);
    };
    window.addEventListener('zero:auth', onAuth);
    return () => window.removeEventListener('zero:auth', onAuth);
  });

  const needLogin = $derived(!!meta && !meta.allowAnonymous && !session.user);
  const isGuest = $derived(!session.user);
  /**
   * 登录入口要同时看两个开关：后台注册开关 + 「前台账号系统」总开关。
   * 总开关关掉时整站无处登录，按钮留着只会把游客引到一个打不开的页面。
   */
  const showLogin = $derived(isGuest && commentConfig.allowRegister && commentConfig.accountSystemEnabled);
  /** 提交按钮之前的顺序固定是 表情 → 发表评论 → 登录，提示文案跟在最后 */
  const allowPost = $derived(!needLogin);
</script>

<section class="zc" use:hostAccent class:is-dark={hostTheme.dark} class:is-light={!hostTheme.dark}>
  {#if loading && !meta}
    <p class="hint">{t('loading')}</p>
  {:else if !meta}
    <p class="hint error-text">{listError || t('unavailable')}</p>
  {:else if !meta.commentEnabled}
    <p class="hint">{t('closed')}</p>
  {:else}
    <!-- 这颗是 h2 不是 h3：文章页的标题序列是 h1（文名）→ 正文小标题 h2 → 这里，
         以前写 h3 会让「正文没有小标题」的文章出现 h1→h3 跳级（Lighthouse/axe 都报，T3-2）。
         字号由下面那条 .title{font-size:1.05rem} 类名规则定，且在 shadowRoot 内，
         主题全局的 h2 样式进不来 —— 换成 h2 视觉一个像素都不动。 -->
    <h2 class="title">{t('commentsTitle')}{meta.total ? ` (${meta.total})` : ''}</h2>

    <div class="sorts">
      {#each [['oldest', t('sortOldest')], ['latest', t('sortLatest')], ['hot', t('sortHot')]] as [k, label] (k)}
        <button type="button" class:active={sort === k} disabled={loading} onclick={() => setSort(k as SortKey)}>
          {label}
        </button>
      {/each}
      {#if loadingMore}<span class="hint inline">{t('loadingMore')}</span>{/if}
    </div>

    {#if doneMessage}<p class="done">{doneMessage}</p>{/if}

    {#if !collapsed}
      <div class="main-form">
        <CommentEditor
          bind:value={mainDraft}
          placeholder={t('placeholder')}
          {shortBase}
          lang={effectiveLang}
          rows={4}
          {packs}
          busy={mainSubmitting}
          error={mainError}
          disabled={!allowPost}
          submitLabel={t('submit')}
          fields={guestFields}
          trailing={mainTrailing}
          onsubmit={() => submit(null)}
        />
      </div>
    {/if}

    {#if tree.length === 0 && mineList.length === 0 && !doneMessage}
      <p class="hint">{t('empty')}</p>
    {/if}

    {#if listError && meta}<p class="error-text">{listError}</p>{/if}

    <!-- collapsed 只收起上面的编辑器，评论列表始终显示（时刻页要常显列表） -->
    <div class="list">
      {#each tree as root (root.id)}
        {@const reps = root.replies ?? []}
        <div class="group">
          <CommentNode
            node={root}
            {ctx}
            {shortBase}
            slug={key}
            lang={effectiveLang}
            {showMeta}
            {likeEnabled}
            {packs}
            identity={guestFields}
          />
          {#if reps.length}
            <!-- 二级平铺：回复不再嵌套，整体缩进到顶层正文那一列下面顺着排 -->
            <div class="replies">
              {#each visibleReplies(root) as rep (rep.id)}
                <CommentNode
                  node={rep}
                  {ctx}
                  {shortBase}
                  slug={key}
                  lang={effectiveLang}
                  {showMeta}
                  {likeEnabled}
                  {packs}
                  identity={guestFields}
                />
              {/each}
              {#if hiddenReplies(root) > 0}
                <button type="button" class="expand" onclick={() => expandReplies(root)}>
                  {t('expandMore', { n: reps.length })}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    {#if mineList.length}
      <p class="hint mine-title">{t('myPending')}</p>
      <div class="list mine">
        {#each mineList as node (node.id)}
          <CommentNode
            {node}
            {ctx}
            {shortBase}
            slug={key}
            lang={effectiveLang}
            {showMeta}
            {likeEnabled}
            {packs}
            identity={guestFields}
          />
        {/each}
      </div>
    {/if}

    {#if meta.hasMore}
      <button class="more" disabled={loadingMore} onclick={() => load(false, sort, { offset: tree.length })}>
        {loadingMore ? t('loadingMore') : t('loadMore')}
      </button>
    {/if}
  {/if}

  {#snippet guestFields()}
    {#if isGuest && meta?.allowAnonymous}
      <div class="id-row">
        <input
          placeholder={t('emailField')}
          type="email"
          bind:value={guestEmail}
          maxlength="200"
          autocomplete="email"
          inputmode="email"
          required
          aria-required="true"
          aria-label={t('emailField')}
        />
        <input placeholder={t('nickname')} bind:value={guestName} maxlength="64" autocomplete="nickname" aria-label={t('nickname')} />
        <input
          placeholder={t('websiteField')}
          type="url"
          bind:value={guestLink}
          maxlength="300"
          autocomplete="url"
          aria-label={t('websiteField')}
        />
      </div>
      <p class="hint id-hint">{t('guestHint')}</p>
    {/if}
  {/snippet}

  {#snippet mainTrailing()}
    {#if showLogin}
      <a class="primary login" href={loginHref}>{t('login')}</a>
    {/if}
    {#if needLogin}<span class="hint inline">{t('needLogin')}</span>{/if}
    {#if meta?.requireReview && isGuest && !needLogin}<span class="hint inline">{t('reviewHint')}</span>{/if}
    {#if session.user}<span class="hint inline">{t('actingAs', { name: session.user.name })}</span>{/if}
  {/snippet}
</section>

<style>
  /* ------------------------------------------------------------------
   * 颜色一律走变量：宿主主题（data-theme=dark 或跟随系统的 prefers-color-scheme）
   * 会重写 --text / --card-bg 这一批，组件先拿宿主的，拿不到才用下面这套浅色兜底。
   * ----------------------------------------------------------------*/
  .zc {
    --zc-fg: var(--text, #333);
    --zc-muted: var(--text-secondary, #888);
    --zc-border: var(--border, #e2e2e2);
    --zc-bg: var(--card-bg, #fff);
    --zc-code-bg: var(--tag-bg, #f4f4f5);
    --zc-accent: var(--logo-accent-text, #0070f3);
    --zc-on-accent: var(--btn-color, #fff);
    --zc-group: #6d5bd0;
    --zc-like: #e0245e;
    --zc-like-bg: rgba(224, 36, 94, 0.12);
    --zc-danger: #dc2626;
    --zc-warn: #b45309;
    --zc-ok: #16a34a;
    --zc-tint: rgba(0, 112, 243, 0.1);
    --zc-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    font-size: 15px;
    color: var(--zc-fg);
  }

  /* 深色：JS 认出来的 data-theme=dark（含宿主只有 auto 但系统是深色的情况） */
  .zc.is-dark {
    --zc-fg: var(--text, #eaeaea);
    --zc-muted: var(--text-secondary, #a5a5a5);
    --zc-border: var(--border, #3d3d3d);
    --zc-bg: var(--card-bg, #232323);
    --zc-code-bg: var(--tag-bg, #2e2e2e);
    --zc-accent: var(--logo-accent-text, #7aa2ff);
    --zc-on-accent: var(--btn-color, #101010);
    --zc-group: #b39dff;
    --zc-like: #ff6b9a;
    --zc-like-bg: rgba(255, 107, 154, 0.18);
    --zc-danger: #f87171;
    --zc-warn: #fbbf24;
    --zc-ok: #4ade80;
    --zc-tint: rgba(122, 162, 255, 0.18);
    --zc-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }

  /* 没跑 JS 的兜底：系统深色且宿主没显式声明浅色 */
  @media (prefers-color-scheme: dark) {
    .zc:not(.is-light) {
      --zc-fg: var(--text, #eaeaea);
      --zc-muted: var(--text-secondary, #a5a5a5);
      --zc-border: var(--border, #3d3d3d);
      --zc-bg: var(--card-bg, #232323);
      --zc-code-bg: var(--tag-bg, #2e2e2e);
      --zc-accent: var(--logo-accent-text, #7aa2ff);
      --zc-on-accent: var(--btn-color, #101010);
      --zc-group: #b39dff;
      --zc-like: #ff6b9a;
      --zc-like-bg: rgba(255, 107, 154, 0.18);
      --zc-danger: #f87171;
      --zc-warn: #fbbf24;
      --zc-ok: #4ade80;
      --zc-tint: rgba(122, 162, 255, 0.18);
      --zc-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }
  }

  .title { font-size: 1.05rem; margin: 0 0 0.9rem; }
  .hint { color: var(--zc-muted); font-size: 0.85rem; margin: 0.4rem 0; }
  .hint.inline { margin: 0; }
  .hint.mine-title { margin-top: 1rem; }
  .hint.id-hint { margin: 0.35rem 0 0; font-size: 0.78rem; }
  .error-text { color: var(--zc-danger); font-size: 0.85rem; }
  .done { color: var(--zc-ok); font-size: 0.88rem; margin: 0 0 0.6rem; }
  .sorts { display: flex; align-items: center; gap: 0.35rem; margin: -0.4rem 0 0.9rem; flex-wrap: wrap; }
  .sorts button {
    font: inherit; font-size: 0.78rem; padding: 0.15rem 0.6rem; border-radius: 999px;
    border: 1px solid var(--zc-border); background: var(--zc-bg); color: var(--zc-muted); cursor: pointer;
  }
  .sorts button:hover { color: var(--zc-fg); border-color: var(--zc-accent); }
  .sorts button.active { color: var(--zc-on-accent); background: var(--zc-accent); border-color: var(--zc-accent); }
  .sorts button:disabled { opacity: 0.55; cursor: not-allowed; }
  .main-form { margin-bottom: 0.4rem; }
  .id-row { display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
  .id-row input {
    flex: 1; min-width: 160px; border: 1px solid var(--zc-border); border-radius: 8px;
    padding: 0.45rem 0.6rem; font: inherit; background: var(--zc-bg); color: var(--zc-fg);
  }
  .id-row input::placeholder { color: var(--zc-muted); }
  .login {
    display: inline-flex; align-items: center; border-radius: 8px; padding: 0.35rem 0.9rem;
    font: inherit; text-decoration: none; background: var(--zc-accent); border: 1px solid var(--zc-accent);
    color: var(--zc-on-accent);
  }
  .login:hover { filter: brightness(1.08); }
  .list { display: flex; flex-direction: column; gap: 1rem; margin-top: 1.1rem; }
  .group { display: flex; flex-direction: column; gap: 0.9rem; }
  /* 楼中楼整体向右缩一层：桌面正好对齐顶层头像右边的昵称列（36px 头像 + 0.65rem 间距 ≈ 46px），
   * 屏幕越窄缩得越少；回复项自己不加框，只留左边这条线程线做分组。 */
  .replies {
    display: flex; flex-direction: column; gap: 0.9rem;
    margin-left: 46px; padding-left: 0.9rem; border-left: 2px solid var(--zc-border);
  }
  @media (max-width: 860px) {
    .replies { margin-left: 28px; padding-left: 0.7rem; }
  }
  @media (max-width: 560px) {
    .replies { margin-left: 15px; padding-left: 0.55rem; }
  }
  .list.mine { gap: 0.7rem; }
  .expand {
    align-self: flex-start; background: none; border: none; padding: 0.1rem 0; cursor: pointer;
    font: inherit; font-size: 0.82rem; color: var(--zc-accent);
  }
  .expand:hover { text-decoration: underline; }
  .more {
    align-self: flex-start; margin-top: 1rem; border-radius: 999px; color: var(--zc-muted);
    border: 1px solid var(--zc-border); background: var(--zc-bg); padding: 0.35rem 0.9rem; font: inherit; cursor: pointer;
  }
  .more:hover { color: var(--zc-accent); border-color: var(--zc-accent); }
  .more:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
