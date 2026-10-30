<script lang="ts">
  import { get, healthWarn, patch, post, put, type BuildHealth } from '#lib/api';
  import { assetUrl, session } from '#lib/session.svelte';
  import MediaPicker from '../content/MediaPicker.svelte';
  import { EP, LOGIN_POLICIES, POLICY_LABELS, errText } from './endpoints';

  /**
   * 我的信息：身份卡 + 站长作者资料 + 账号资料 + 改密码 + 身份验证器 + 登录方式。
   * 用户组不在这里改：那是「用户」页管理员给别人分的身份，本人没有切换入口。
   *
   * 一切路径与字段名都取自 packages/api 源码（见 endpoints.ts）：
   * 安全类接口挂在 /api/security，改密码只有 POST /api/account/password，
   * 资料是 PATCH /api/user/profile，策略是 PATCH /api/admin/config，注销走 /api/account/delete-request。
   * 后端的中文 message 原样显示，不替换成「操作失败」。
   */

  /** GET /api/security —— routes/security.ts 的概览 */
  interface SecOverview {
    id: string;
    email: string;
    name: string | null;
    accountSlug: string | null;
    userGroup: string;
    role: string;
    isAdmin: boolean;
    emailVerified: boolean;
    totpEnabled: boolean;
    totpReadable: boolean;
    githubLinked: boolean;
    githubAccountId: string | null;
    policy: string;
    required: { password: boolean; emailCode: boolean; totp: boolean; githubOnly: boolean };
    notice: string | null;
    methods: Array<{ kind: string; label: string; enabled: boolean; required: boolean; available: boolean }>;
    secondFactors: Array<{ kind: string; label: string; available: boolean }>;
    github: { configured: boolean; missing: string[]; redirectConfigured: boolean; message: string };
    totpIssuer: string;
  }

  /** GET /api/user/permissions —— routes/user.ts */
  interface Profile {
    name: string | null;
    handle: string | null;
    email: string;
    image: string | null;
    bio: string | null;
    website: string | null;
    role: string;
    canPublish: boolean;
    canAuthor: boolean;
    authorVerified: boolean;
    emailVerified: boolean;
    createdAt: number;
    isAdmin: boolean;
  }

  /** POST /api/security/totp/setup */
  interface TotpSetup {
    secret: string;
    manualEntry: string;
    otpauthUrl: string;
    issuer: string;
    account: string;
    expiresIn: number;
    message: string;
  }

  /** GET /api/account/delete-request */

  let profile = $state<Profile | null>(null);
  let sec = $state<SecOverview | null>(null);

  let loading = $state(false);
  let busy = $state('');
  let error = $state('');
  let notice = $state('');
  /** GET 失败的路径 → 原因，页面顶部统一列出，方便对着补后端 */
  let gaps = $state<Record<string, string>>({});

  function markGap(path: string, e: unknown) {
    gaps = { ...gaps, [path]: errText(e) };
  }

  /** 单个区块读失败不影响其它区块 */
  async function guard<T>(path: string, fn: () => Promise<{ data: T }>): Promise<T | null> {
    try {
      const r = await fn();
      const next = { ...gaps };
      delete next[path];
      gaps = next;
      return r.data ?? null;
    } catch (e) {
      markGap(path, e);
      return null;
    }
  }

  /* ---------------------------------------------------------------- 读取 */

  let name = $state('');
  let website = $state('');
  let image = $state('');
  let bio = $state('');

  async function loadProfile() {
    const p = await guard<Profile>(EP.permissions, () => get(EP.permissions));
    if (!p) return;
    profile = p;
    name = p.name ?? '';
    website = p.website ?? '';
    image = p.image ?? '';
    bio = p.bio ?? '';
  }

  async function loadSecurity() {
    sec = await guard<SecOverview>(EP.securityOverview, () => get(EP.securityOverview));
    /** 概览回来后挑第一个后端说可用的凭据 */
    if (!second) {
      const first = sec?.secondFactors.find((f) => f.available)?.kind;
      if (first) second = first;
    }
  }

  async function loadAll() {
    loading = true;
    error = '';
    try {
      await loadProfile();
      await loadSecurity();
      await loadAuthor();
    } finally {
      loading = false;
    }
  }

  /* ---------------------------------------------------------------- 资料 */

  const policy = $derived(sec?.policy ?? 'password');
  const issuer = $derived(sec?.totpIssuer ?? 'Zero');
  const savedImage = $derived(profile?.image ?? '');

  async function saveProfile() {
    if (!name.trim()) {
      error = '昵称不能为空（后端 name 要求 1–64 个字符）';
      return;
    }
    busy = 'profile';
    error = '';
    notice = '';
    const body = { name: name.trim(), bio: bio.trim(), website: website.trim(), image: image.trim() };
    try {
      const res = await patch<{ data: { image: string | null; ownerSync: OwnerSync | null } }>(EP.profile, body);
      const p = await guard<Profile>(EP.permissions, () => get(EP.permissions));
      if (p) profile = p;
      await session.refresh();
      notice = [
        (p?.image ?? '') === body.image
          ? '资料已保存（昵称 / 简介 / 个人站 / 头像）。'
          : `资料已保存，但头像没有入库：后端 ${EP.profile} 回读的 image 与提交的不一致。`,
        ownerSyncText(res?.data?.ownerSync),
      ]
        .filter(Boolean)
        .join(' ');
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  /** PATCH /api/user/profile 回关于页同步那段的结果（只有站长那份有） */
  interface OwnerSync {
    ok: boolean;
    changed: boolean;
    detail: string;
    build?: { triggered: boolean; error?: string };
  }

  /**
   * 站长的账号资料会顺手写进内容仓库的 data/owner.json，前台关于页顶部的头像与昵称读那份。
   * 写没写、重建成没建成都要说清楚——不说，人只会觉得「后台改了前台不动」。
   */
  function ownerSyncText(s: OwnerSync | null | undefined): string {
    if (!s) return '';
    if (!s.ok) return `关于页没同步（${s.detail}）：账号资料本身已保存，前台还是原来的头像与昵称。`;
    if (!s.changed) return '前台关于页的头像与昵称本来就是这份，不用重建。';
    return s.build?.triggered
      ? '已同步到前台关于页（头像与昵称），等这次站点构建完成就生效。'
      : `已写入 data/owner.json，但没能自动触发构建（${s.build?.error ?? '未知原因'}）：去 Cloudflare Pages 手动构建一次才会换下来。`;
  }

  let showAvatar = $state(false);

  /* ------------------------------------------------- 站长作者资料（data/authors.yaml） */

  /** GET /api/admin/authors/me 的 profile；social 的键就是平台名 */
  interface AuthorRow {
    name?: string;
    avatar?: string;
    email?: string;
    bio_zh?: string;
    website?: string;
    social?: Record<string, string> | Array<Record<string, string>>;
    donate?: string[];
  }

  /** 联系方式一栏：值就是链接，留空的项不写进 yaml */
  const SOCIAL_FIELDS = [
    { key: 'github', label: 'GitHub' },
    { key: 'twitter', label: 'Twitter / X' },
    { key: 'weibo', label: '微博' },
    { key: 'bilibili', label: 'B站' },
    { key: 'zhihu', label: '知乎' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'telegram', label: 'Telegram' },
    { key: 'email', label: '联系邮箱链接（如 mailto:…）' },
  ] as const;

  let authorHandle = $state('');
  let authorName = $state('');
  let authorAvatar = $state('');
  let authorEmail = $state('');
  let authorBio = $state('');
  let authorSite = $state('');
  let authorSocial = $state<Record<string, string>>({});
  let authorDonate = $state<string[]>([]);
  let authorShowAvatar = $state(false);
  let authorSaving = $state(false);
  /** 站点当前把哪位作者当「站长」（config 键 defaultAuthor） */
  let authorDefault = $state('');

  function socialToMap(social: AuthorRow['social']): Record<string, string> {
    const out: Record<string, string> = {};
    if (!social) return out;
    if (Array.isArray(social)) {
      // 后端兼容列表写法：[{ platform, url }]
      for (const row of social) {
        const key = String(row?.platform ?? row?.key ?? '');
        const val = String(row?.url ?? row?.link ?? '');
        if (key && val) out[key] = val;
      }
      return out;
    }
    for (const [k, v] of Object.entries(social)) if (v) out[k] = String(v);
    return out;
  }

  /** GET /api/admin/authors/me：读自己那一条作者资料，没有就用账号资料铺默认值 */
  async function loadAuthor() {
    const d = await guard<{ handle: string; profile: AuthorRow | null; defaultAuthor?: string }>(EP.authorsMe, () =>
      get<{ data: { handle: string; profile: AuthorRow | null; defaultAuthor?: string } }>(EP.authorsMe),
    );
    if (!d) return;
    authorHandle = d.handle ?? '';
    authorDefault = d.defaultAuthor ?? '';
    const row = d.profile ?? {};
    authorName = String(row.name ?? profile?.name ?? '');
    authorAvatar = String(row.avatar ?? '');
    authorEmail = String(row.email ?? profile?.email ?? '');
    authorBio = String(row.bio_zh ?? profile?.bio ?? '');
    authorSite = String(row.website ?? profile?.website ?? '');
    authorSocial = socialToMap(row.social);
    authorDonate = (row.donate ?? []).map(String).slice(0, 3);
  }

  /** PUT /api/admin/authors/me：只写作者资料，不碰账号资料与登录凭据 */
  async function saveAuthor() {
    if (!authorName.trim() || !authorAvatar.trim() || !authorEmail.trim()) {
      error = '作者昵称、头像、邮箱三项必填（头像留空会导致前台作者卡没有图，后端也会拒绝）';
      return;
    }
    authorSaving = true;
    error = '';
    notice = '';
    try {
      const social: Record<string, string> = {};
      for (const f of SOCIAL_FIELDS) {
        const v = (authorSocial[f.key] ?? '').trim();
        if (v) social[f.key] = v;
      }
      const d = await put<{
        data: {
          path: string;
          created: boolean;
          defaultAuthor?: { ok: boolean; detail: string };
          build?: { triggered: boolean; viaCommit?: boolean; error?: string };
          buildHealth?: BuildHealth | null;
          /** 重建状态的成句话（services/git.ts 的 buildReceipt 拼的），界面只显示它 */
          receipt?: string;
        };
      }>(EP.authorsMe, {
        name: authorName.trim(),
        avatar: authorAvatar.trim(),
        email: authorEmail.trim(),
        bio: authorBio.trim(),
        website: authorSite.trim(),
        social,
        donate: authorDonate.map((s) => s.trim()).filter(Boolean),
      });
      authorDefault = authorHandle;
      /* 署名的真实来源是仓库里的 data/site.json，构建没触发就只是「改了但前台看不到」，
         所以把两件事的结果都写进提示，而不是含糊一句「构建后生效」。
         重建那半句直接用接口拼好的 receipt —— 后台不再自己判 triggered：
         Git 直连构建的站提交即重建，自己判会把每次都正常的保存说成「没触发，请手动重建」。 */
      const da = d.data?.defaultAuthor;
      const parts = [`作者资料已写入 ${d.data?.path ?? 'data/authors.yaml'}${d.data?.created ? '（新增条目）' : ''}`];
      parts.push(
        da?.ok
          ? `默认作者标识已同步到 ${da.detail}`
          : `默认作者标识没能写进仓库（${da?.detail ?? '接口没回结果'}），前台署名不会跟着变，请到「前端管理 → 站点信息」检查`,
      );
      parts.push(d.data?.receipt || '站点重建状态接口没回结果，这次改动要等下一次构建才可见');
      const warn = healthWarn(d.data?.buildHealth);
      if (warn) parts.push(warn);
      notice = parts.join('；');
    } catch (e) {
      error = errText(e);
    } finally {
      authorSaving = false;
    }
  }

  /* ---------------------------------------------------------------- 改密码 */

  const secondFactors = $derived(sec?.secondFactors ?? []);
  /** 默认凭据在 loadSecurity 拿到 secondFactors 后选定，不在这里兜底成后端不认的方式 */
  let second = $state('');

  let curPassword = $state('');
  let newPassword = $state('');
  let code = $state('');
  let codeTtl = $state(0);

  async function sendEmailCode() {
    if (!profile?.email) {
      error = '没读到本账号邮箱，无法发送验证码';
      return;
    }
    busy = 'otp';
    error = '';
    notice = '';
    try {
      const r = await post<{ data: { sent: boolean; ttl: number } }>(EP.sendCode, { email: profile.email, scene: 'reset' });
      codeTtl = r.data?.ttl ?? 0;
      notice = `验证码已发到 ${profile.email}${codeTtl ? `，${Math.round(codeTtl / 60)} 分钟内有效` : ''}`;
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  async function changePassword() {
    error = '';
    notice = '';
    if (newPassword.length < 8) {
      error = '新密码至少 8 位（后端 next 的校验是 min(8) max(200)）';
      return;
    }
    if (!second) {
      error = '请选择一种第二凭据（邮箱验证码 / 身份验证器 / GitHub）';
      return;
    }
    if (second !== 'github' && !code.trim()) {
      error = second === 'totp' ? '请输入验证器上的 6 位动态码' : '请输入邮箱收到的验证码';
      return;
    }
    busy = 'pwd';
    try {
      const body: Record<string, unknown> = { current: curPassword, next: newPassword, second };
      if (second !== 'github') body.code = code.trim();
      const r = await post<{ data: { changed: boolean; message?: string } }>(EP.password, body);
      notice = r.data?.message ?? '密码已更新。';
      curPassword = '';
      newPassword = '';
      code = '';
      await session.refresh();
      await loadSecurity();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  /* ---------------------------------------------------------------- 身份验证器 */

  let totp = $state<TotpSetup | null>(null);
  let enableCode = $state('');
  let offByPassword = $state('');
  let offByCode = $state('');

  async function setupTotp() {
    busy = 'totp-setup';
    error = '';
    notice = '';
    try {
      const r = await post<{ data: TotpSetup }>(EP.totpSetup, { issuer });
      totp = r.data ?? null;
      notice = r.data?.message ?? '';
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  async function enableTotp() {
    if (!/^\d{6}$/.test(enableCode.trim())) {
      error = '请输入验证器当前显示的 6 位动态码';
      return;
    }
    busy = 'totp-enable';
    error = '';
    notice = '';
    try {
      const r = await post<{ data: { enabled: boolean; message?: string } }>(EP.totpEnable, {
        code: enableCode.trim(),
        secret: totp?.secret,
      });
      notice = r.data?.message ?? '身份验证器已开启。';
      totp = null;
      enableCode = '';
      await loadSecurity();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  async function disableTotp() {
    if (!offByPassword && !offByCode.trim()) {
      error = '关闭身份验证器需要当前密码或 6 位动态码（后端二选一）';
      return;
    }
    busy = 'totp-disable';
    error = '';
    notice = '';
    try {
      const body: Record<string, unknown> = {};
      if (offByPassword) body.password = offByPassword;
      if (offByCode.trim()) body.code = offByCode.trim();
      const r = await post<{ data: { enabled: boolean; message?: string; notice?: string | null } }>(EP.totpDisable, body);
      notice = r.data?.message ?? '身份验证器已关闭。';
      if (r.data?.notice) error = r.data.notice;
      offByPassword = '';
      offByCode = '';
      await loadSecurity();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      notice = `已复制${what}`;
      error = '';
    } catch {
      error = '浏览器不允许直接复制，请手动选中';
    }
  }

  /* ---------------------------------------------------------------- GitHub */

  let ghStart = $state<{ authorizeUrl: string; intent: string; callbackUrl: string } | null>(null);
  let ghOffPassword = $state('');
  let ghOffCode = $state('');

  async function linkGithub() {
    busy = 'github';
    error = '';
    notice = '';
    try {
      const r = await post<{ data: { authorizeUrl: string; intent: string; callbackUrl: string } }>(EP.githubStart, { intent: 'bind' });
      ghStart = r.data ?? null;
      if (r.data?.authorizeUrl) window.open(r.data.authorizeUrl, '_blank', 'noopener');
      notice = '已打开 GitHub 授权页，授权完成后回到本页点「刷新」。';
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  async function unlinkGithub() {
    if (!ghOffPassword && !ghOffCode.trim()) {
      error = '解绑 GitHub 需要当前密码或验证器动态码（后端二选一）';
      return;
    }
    busy = 'github';
    error = '';
    notice = '';
    try {
      const body: Record<string, unknown> = {};
      if (ghOffPassword) body.password = ghOffPassword;
      if (ghOffCode.trim()) body.code = ghOffCode.trim();
      const r = await post<{ data: { linked: boolean; message?: string } }>(EP.githubUnbind, body);
      notice = r.data?.message ?? '已解绑 GitHub。';
      ghOffPassword = '';
      ghOffCode = '';
      await loadSecurity();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  /* ---------------------------------------------------------------- 登录方式 */

  async function savePolicy(newPolicy: string, newIssuer: string) {
    busy = 'policy';
    error = '';
    notice = '';
    try {
      const r = await patch<{ data: { updated: number; keys: string[] } }>(EP.config, {
        adminLoginPolicy: newPolicy,
        totpIssuer: newIssuer,
      });
      notice = `已写入配置项：${(r.data?.keys ?? []).join(' / ')}`;
      await loadSecurity();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = '';
    }
  }

  let policyDraft = $state('password');
  let issuerDraft = $state('Zero');
  $effect(() => {
    if (sec) {
      policyDraft = sec.policy;
      issuerDraft = sec.totpIssuer;
    }
  });

  let booted = $state(false);
  $effect(() => {
    if (!booted) {
      booted = true;
      void loadAll();
    }
  });

  const gapList = $derived(Object.entries(gaps));
</script>

<div class="row spread head">
  <h2>我的信息</h2>
  <button class="sm" onclick={() => void loadAll()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
</div>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

{#if gapList.length}
  <div class="card gaps">
    <p class="muted small cap">以下接口没读通，对应区块不可用：</p>
    {#each gapList as [path, msg] (path)}
      <p class="small"><code>{path}</code> — {msg}</p>
    {/each}
  </div>
{/if}

<!-- ---------------------------------------------------------- 身份卡 -->
<section class="card blk id">
  <h3>身份</h3>
  {#if sec || profile}
    <div class="row idrow">
      {#if savedImage}<img class="av" src={assetUrl(savedImage) || savedImage} alt="头像" />{/if}
      <div>
        <p class="who">{profile?.name || sec?.name || '（未设置昵称）'}</p>
        <p class="muted small nowrap">
          {sec?.email ?? profile?.email ?? ''}　账号标识：<code>{sec?.accountSlug ? `@${sec.accountSlug}` : '未分配'}</code>
        </p>
      </div>
      <div class="row badges">
        <span class="badge">{sec?.isAdmin ? '管理员' : sec?.role ?? profile?.role}</span>
        {#if authorHandle}
          <span class="badge" title="文章 front matter 里的 author 写这个标识，就取你这份作者资料">
            作者标识：<code>{authorHandle}</code>
          </span>
        {/if}

        <span class="badge {(sec?.emailVerified ?? profile?.emailVerified) ? 'good' : 'pending'}">
          邮箱{(sec?.emailVerified ?? profile?.emailVerified) ? '已验证' : '未验证'}
        </span>
        <span class="badge {profile?.authorVerified ? 'good' : 'pending'}">
          作者认证{profile?.authorVerified ? '已通过' : '未通过'}
        </span>
        <span class="badge {sec?.totpEnabled ? 'good' : 'pending'}">验证器{sec?.totpEnabled ? '已启用' : '未启用'}</span>
        <span class="badge {sec?.githubLinked ? 'good' : 'pending'}">GitHub{sec?.githubLinked ? '已绑定' : '未绑定'}</span>
        <span class="badge">登录方式：{POLICY_LABELS[policy] ?? policy}</span>
      </div>
    </div>
    {#if sec?.notice}<p class="warn small">{sec.notice}</p>{/if}
    {#if sec && !sec.totpReadable && sec.totpEnabled}
      <p class="warn small">
        验证器已启用但密钥解不开（totpReadable=false，多半换过 SESSION_SECRET），后端无法再校验动态码，请关闭后重新绑定。
      </p>
    {/if}
  {:else}
    <p class="muted small">{loading ? '读取中…' : '没读到身份信息，请先登录后台。'}</p>
  {/if}
</section>

<!-- ---------------------------------------------------------- 资料编辑 -->
<section class="card blk">
  <h3>账号资料</h3>
  <p class="muted small">
    保存到 PATCH {EP.profile}，后端接受 name / bio / website / image。
    站长的这一份还会同步进内容仓库的 <code>data/owner.json</code>：前台关于页顶部的头像与昵称读的就是它
    （没填头像时按邮箱取 Gravatar→Cravatar→QQ），保存后会提示同步结果与是否已触发站点构建。
  </p>
  {#if profile}
    <div class="grid2">
      <label>昵称<input bind:value={name} maxlength="64" /></label>
      <label>邮箱（只读）<input value={profile.email} readonly title="改邮箱要走后端专门的验证码流程，当前没有接口" /></label>
      <label>个人站<input bind:value={website} placeholder="https://…" /></label>
      <label>头像地址<input bind:value={image} placeholder="https://… 或从媒体库选择" /></label>
    </div>
    <div class="block">
      <span class="lbl">一句话简介</span>
      <textarea rows="2" maxlength="200" bind:value={bio} placeholder="认证后展示在作者卡片上"></textarea>
    </div>
    <div class="row">
      <button class="sm" onclick={() => (showAvatar = true)}>从媒体库选头像</button>
      {#if image}<img class="av" src={assetUrl(image) || image} alt="头像预览" />{/if}
      {#if savedImage && savedImage !== image.trim()}<span class="muted small">已入库头像：<code>{savedImage}</code></span>{/if}
      <button class="primary" onclick={() => void saveProfile()} disabled={busy === 'profile'}>
        {busy === 'profile' ? '保存中…' : '保存资料'}
      </button>
    </div>
  {:else}
    <p class="muted small">{loading ? '读取中…' : '没读到账号资料，请先登录后台。'}</p>
  {/if}
</section>

<!-- --------------------------------------- 站长作者资料（写 data/authors.yaml） -->
<section class="card blk">
  <h3>站长作者资料</h3>
  <p class="muted small">
    这里改的是<em>作者身份</em>：写进站点 <code>data/authors.yaml</code> 里 <code>{authorHandle || '（无作者标识）'}</code>
    那一条。文章 front matter 的 <code>author:</code> 写这个标识，前台署名、作者卡片、赞赏入口、SEO 里的作者就都取这份；
    文章没写作者时同样回落到它。账号资料（上一卡）与登录凭据不受这里影响。
  </p>
  {#if authorHandle}
    <div class="grid2">
      <label>作者昵称 *<input bind:value={authorName} maxlength="64" /></label>
      <label>联系邮箱 *<input bind:value={authorEmail} maxlength="160" placeholder="用于头像兜底与回复提醒" /></label>
      <label>头像地址 *
        <input bind:value={authorAvatar} placeholder="img/avatar.webp 或 https://…" />
      </label>
      <label>个人站点<input bind:value={authorSite} placeholder="https://…" /></label>
    </div>
    <div class="block">
      <span class="lbl">一句话简介</span>
      <textarea rows="2" maxlength="200" bind:value={authorBio} placeholder="显示在作者卡片与文章末尾的作者框里"></textarea>
    </div>
    <span class="lbl">联系方式（留空的不写入）</span>
    <div class="grid2">
      {#each SOCIAL_FIELDS as f (f.key)}
        <label>
          {f.label}
          <input bind:value={authorSocial[f.key]} placeholder="https://…" />
        </label>
      {/each}
    </div>
    <span class="lbl">赞赏图片地址（最多 3 张，留空则前台不显示赞赏按钮）</span>
    <div class="row growrow">
      {#each [0, 1, 2] as i (i)}
        <input bind:value={authorDonate[i]} placeholder="img/donate-wechat.png 或 https://…" />
      {/each}
    </div>
    <div class="row">
      <button class="sm" onclick={() => (authorShowAvatar = true)}>从媒体库选头像</button>
      {#if authorAvatar}<img class="av" src={assetUrl(authorAvatar) || authorAvatar} alt="作者头像预览" />{/if}
      {#each authorDonate.filter(Boolean) as url (url)}
        {#if /\.(png|jpe?g|webp|avif|gif)$/i.test(url)}<img class="av" src={assetUrl(url) || url} alt="赞赏码预览" />{/if}
      {/each}
      <button class="primary" onclick={() => void saveAuthor()} disabled={authorSaving}>
        {authorSaving ? '保存中…' : '保存作者资料'}
      </button>
      {#if authorDefault && authorDefault !== authorHandle}
        <span class="muted small">
          注意：config 里的 defaultAuthor 现在是 <code>{authorDefault}</code>，保存本卡后会改指向 <code>{authorHandle}</code>。
        </span>
      {/if}
    </div>
    {#if gaps[EP.authorsMe]}<p class="warn small">作者资料没读到：{gaps[EP.authorsMe]}</p>{/if}
  {:else}
    <p class="muted small">
      {loading ? '读取中…' : '没读到作者标识（handle）。作者标识在「用户」页里维护，先给自己补一个再来编辑作者资料。'}
    </p>
  {/if}
</section>
<MediaPicker bind:open={authorShowAvatar} title="选择作者头像" onpick={(url) => (authorAvatar = url)} />

<!-- ---------------------------------------------------------- 改密码 -->
<section class="card blk">
  <h3>修改密码</h3>
  <p class="muted small">唯一入口 POST {EP.password}，body 为 current / next / second / code。</p>
  <div class="grid2">
    <label>当前密码<input type="password" bind:value={curPassword} autocomplete="current-password" /></label>
    <label>新密码<input type="password" bind:value={newPassword} autocomplete="new-password" maxlength="200" /></label>
  </div>
  {#if secondFactors.length}
    <div class="row">
      {#each secondFactors as f (f.kind)}
        <label class="switch" title={f.available ? '' : '后端判定本凭据当前不可用'}>
          <input type="radio" name="second" value={f.kind} bind:group={second} disabled={!f.available} />
          <span>{f.label}{f.available ? '' : '（不可用）'}</span>
        </label>
      {/each}
    </div>
  {:else}
    <p class="muted small">没读到 secondFactors，请先登录后刷新。</p>
  {/if}
  {#if second === 'email'}
    <div class="row">
      <input class="code" placeholder="邮箱验证码" inputmode="numeric" maxlength="8" bind:value={code} />
      <button class="sm" onclick={() => void sendEmailCode()} disabled={busy === 'otp'}>发送验证码</button>
    </div>
  {:else if second === 'totp'}
    <div class="row">
      <input class="code" placeholder="6 位动态码" inputmode="numeric" maxlength="6" bind:value={code} />
      {#if !sec?.totpEnabled}<span class="muted small">本账号还没绑定身份验证器，先在下面绑定，或改选邮箱验证码。</span>{/if}
    </div>
  {:else if second === 'github'}
    <p class="muted small">
      {sec?.github.configured
        ? '用已绑定的 GitHub 授权做持有证明校验，不需要再填码。'
        : sec?.github.message || '后端未配置 GitHub OAuth，本凭据不可用。'}
    </p>
  {/if}
  <div class="row">
    <button class="primary" onclick={() => void changePassword()} disabled={busy === 'pwd'}>
      {busy === 'pwd' ? '提交中…' : '修改密码'}
    </button>
  </div>
</section>

<!-- ---------------------------------------------------------- 身份验证器 -->
<section class="card blk">
  <h3>身份验证器（TOTP）绑定状态</h3>
  <p class="muted small">
    这一块只表示本账号有没有绑定验证器，<strong>不决定</strong>登录要不要动态码 ——
    管理员要不要码由上面「管理员登录方式」说了算；普通用户绑了验证器之后，
    是他们自己在用户中心的「两步验证」里勾选登录时要不要这一道（默认要），不受这里影响。
    状态：{sec?.totpEnabled ? '已绑定' : '未绑定'}　签发方（totpIssuer）：<code>{issuer}</code>
  </p>
  {#if sec?.totpEnabled}
    <p class="muted small">关闭需要「当前密码」或「6 位动态码」任一（后端二选一）。</p>
    <div class="row">
      <input type="password" placeholder="当前密码" bind:value={offByPassword} autocomplete="current-password" />
      <input class="code" placeholder="或 6 位动态码" inputmode="numeric" maxlength="6" bind:value={offByCode} />
      <button class="sm danger" onclick={() => void disableTotp()} disabled={busy === 'totp-disable'}>
        {busy === 'totp-disable' ? '处理中…' : '关闭验证器'}
      </button>
    </div>
  {:else}
    <div class="row">
      <button class="sm" onclick={() => void setupTotp()} disabled={busy === 'totp-setup'}>生成密钥与 otpauth 链接</button>
      <span class="muted small">POST {EP.totpSetup}：签发方取后台的 totpIssuer。</span>
    </div>
    {#if totp}
      <div class="totp">
        <label>手工输入密钥（Base32）
          <div class="row">
            <code class="secret">{totp.manualEntry || totp.secret}</code>
            <button class="sm ghost" onclick={() => void copy(totp?.manualEntry || totp?.secret || '', '密钥')}>复制</button>
          </div>
        </label>
        <label>otpauth 链接
          <div class="row growrow">
            <input class="wide" value={totp.otpauthUrl} readonly />
            <button class="sm ghost" onclick={() => void copy(totp?.otpauthUrl ?? '', 'otpauth 链接')}>复制</button>
          </div>
        </label>
        <p class="muted small">
          账户：{totp.account}　签发方：{totp.issuer}　有效期：{Math.round(totp.expiresIn / 60)} 分钟。后端不返回二维码图片，
          请在验证器 App 里用上面的链接或密钥手动导入。
        </p>
        <div class="row">
          <input class="code" placeholder="输入当前 6 位码启用" inputmode="numeric" maxlength="6" bind:value={enableCode} />
          <button class="primary" onclick={() => void enableTotp()} disabled={busy === 'totp-enable'}>
            {busy === 'totp-enable' ? '校验中…' : '启用'}
          </button>
        </div>
      </div>
    {/if}
  {/if}
</section>

<!-- ---------------------------------------------------------- GitHub -->
<section class="card blk">
  <h3>GitHub 绑定</h3>
  {#if sec && !sec.github.configured}
    <p class="warn">{sec.github.message || '后端未配置 GitHub OAuth。'}</p>
    {#if sec.github.missing.length}<p class="muted small">缺少的环境变量：{sec.github.missing.join('、')}</p>{/if}
  {:else if sec?.githubLinked}
    <p class="muted small">
      已绑定 GitHub 账号 ID：<code>{sec.githubAccountId ?? '未返回'}</code>
      （接口不返回登录名，只有 providerAccountId）
    </p>
    <p class="muted small">解绑需要「当前密码」或「6 位动态码」任一：</p>
    <div class="row">
      <input type="password" placeholder="当前密码" bind:value={ghOffPassword} autocomplete="current-password" />
      <input class="code" placeholder="或 6 位动态码" inputmode="numeric" maxlength="6" bind:value={ghOffCode} />
      <button class="sm danger" onclick={() => void unlinkGithub()} disabled={busy === 'github'}>
        {busy === 'github' ? '处理中…' : '解绑 GitHub'}
      </button>
    </div>
  {:else}
    <p class="muted small">未绑定。绑定意图（intent=bind）要求本账号已登录，授权后由后端写入 accounts 表。</p>
    <div class="row">
      <button class="sm" onclick={() => void linkGithub()} disabled={busy === 'github'}>
        {busy === 'github' ? '处理中…' : '去 GitHub 授权'}
      </button>
    </div>
  {/if}
  {#if ghStart}
    <p class="muted small">
      回调地址：<code>{ghStart.callbackUrl}</code> —— 授权完成会跳到站内 <code>{ghStart.intent}</code> 流程的落地页，
      回到本页点「刷新」看绑定状态。
    </p>
  {/if}
  {#if sec?.github.configured && !sec.github.redirectConfigured}
    <p class="warn small">后端没配 GITHUB_REDIRECT_URI，授权回调可能落到 API 域名而不是站点。</p>
  {/if}
</section>

<!-- ---------------------------------------------------------- 登录方式 -->
<section class="card blk">
  <h3>管理员登录方式（只约束后台管理员，不是本账号的开关）</h3>
  <p class="muted small">
    这里决定的是「<strong>管理员</strong>登录后台要交哪几样凭据」：写配置键 adminLoginPolicy / totpIssuer（PATCH {EP.config}），
    取值与后端 LOGIN_POLICIES 完全一致，一共四种：单密码 / 密码 + 身份验证器 / GitHub 登录 / 密码 + 邮箱验证码。
    选「密码」时就算下面的验证器处于已绑定状态，登录也只要密码；
    只有选了「密码 + 身份验证器」才要 6 位动态码。不提供「只要动态码」这一种：丢了验证器不该把人锁在站外。
  </p>
  <p class="muted small">
    普通用户不跟这条策略走：他们在前台永远是邮箱 + 密码，邮箱验证码只用来验证邮箱（注册、找回密码、绑定验证器），
    不作为登录因子。谁绑了身份验证器，谁就在自己的用户中心里决定登录时要不要那枚动态码（默认要）。
    管理员从站点登录页进门时也按这里的策略走；选了「密码 + 邮箱验证码」就用后台的登录页，站点那一侧没有这一步。
  </p>
  <div class="grid2">
    <label>
      管理员登录方式
      <select bind:value={policyDraft}>
        {#each LOGIN_POLICIES as p (p)}
          <option value={p}>{POLICY_LABELS[p]}</option>
        {/each}
      </select>
    </label>
    <label>验证器签发方<input bind:value={issuerDraft} maxlength="60" /></label>
  </div>
  <p class="muted small">当前生效：<code>{POLICY_LABELS[policy] ?? policy}</code>（后端按策略与实际配置算出的提示见页顶）</p>
  <div class="row">
    <button class="primary" onclick={() => void savePolicy(policyDraft, issuerDraft)} disabled={busy === 'policy'}>
      {busy === 'policy' ? '保存中…' : '保存登录方式'}
    </button>
  </div>
</section>

<MediaPicker bind:open={showAvatar} title="选择头像" onpick={(url) => (image = url)} />

<style>
  .head {
    margin-bottom: 0.7rem;
  }
  .small {
    font-size: 0.76rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  .gaps {
    margin-bottom: 0.7rem;
    padding: 0.7rem 0.9rem;
  }
  .gaps .cap {
    margin: 0 0 0.3rem;
  }
  .gaps p {
    margin: 0.15rem 0;
  }
  .gaps code {
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0 0.3rem;
  }
  .blk {
    margin-bottom: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .blk h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .id .idrow {
    align-items: flex-start;
    gap: 1rem;
  }
  .who {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .badges {
    margin-left: auto;
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.6rem;
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .lbl {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .av {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid var(--border);
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: var(--fg);
  }
  .code {
    width: 150px;
  }
  .wide {
    flex: 1;
    min-width: 240px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.8rem;
  }
  .growrow {
    flex: 1;
  }
  .totp {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
  }
  .secret {
    font-family: ui-monospace, Consolas, monospace;
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0.15rem 0.4rem;
    letter-spacing: 0.08em;
  }
  code {
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0 0.3rem;
  }
  input[readonly] {
    background: #f9fafb;
    color: var(--muted);
  }
</style>
