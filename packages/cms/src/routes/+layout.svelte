<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { session } from '#lib/session.svelte';
  import { get, post } from '#lib/api';

  let { children } = $props();

  const isLogin = $derived(page.url.pathname === '/login');
  const ready = $derived(session.checked);
  /** 站点账号系统里 role 只有 admin / reader：后台只属于 admin，其他人进来一律当作不存在这个页面 */
  const isAdmin = $derived(session.user?.role === 'admin');
  const denied = $derived(!isLogin && ready && !!session.user && !isAdmin);

  const year = new Date().getFullYear();
  const copyright = `©2026${year > 2026 ? `—${year}` : ''} designed by 知止`;

  // 侧栏图标统一用内联 SVG：stroke=currentColor，颜色随菜单项状态变化，不依赖图标字体
  const I: Record<string, string> = {
    dashboard:
      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    chart: '<line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="13"/><line x1="20" y1="20" x2="20" y2="7"/>',
    posts:
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    drafts:
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    moments: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    media:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    comments:
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
    applications:
      '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    friends:
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    users:
      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    award: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
    // 我的信息：账号圈 + 人形，与 users / shield 同一套描线风格
    myinfo: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.6 18.2a6 6 0 0 1 10.8 0"/>',
    // 翻译：地球 + 经线，和 moments 的圆一致
    translate:
      '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
    subscribers: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/>',
    broadcast:
      '<path d="M3 11l18-7v16l-18-7v-2z"/><path d="M11.5 14.5V21"/>',
    frontend:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    settings:
      '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    backup:
      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
    // 操作流水：三行清单 + 行首圆点，表示「按时间排下来的记录」
    audit:
      '<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.4"/><circle cx="4" cy="12" r="1.4"/><circle cx="4" cy="18" r="1.4"/>',
  };

  const NAV: { title: string; items: [string, string, string][] }[] = [
    {
      title: '概览',
      items: [
        ['/', 'dashboard', '仪表盘'],
        ['/stats', 'chart', '访问统计'],
      ],
    },
    {
      title: '内容',
      items: [
        ['/content', 'posts', '文章'],
        ['/translate', 'translate', '翻译'],
        ['/drafts', 'drafts', '投稿审核'],
        ['/moments', 'moments', '时刻'],
        ['/media', 'media', '媒体'],
      ],
    },
    {
      title: '互动',
      items: [
        ['/comments', 'comments', '评论'],
        ['/spam', 'shield', '评论审核'],
        ['/friends', 'friends', '友链'],
        ['/users', 'users', '用户'],
        ['/author-verify', 'award', '作者认证'],
        ['/subscribers', 'subscribers', '订阅'],
        ['/broadcast', 'broadcast', '群发'],
      ],
    },
    {
      title: '站点',
      items: [
        ['/frontend', 'frontend', '前端管理'],
        ['/settings', 'settings', '设置'],
        ['/backup', 'backup', '备份'],
        ['/audit', 'audit', '操作流水'],
        ['/my-info', 'myinfo', '我的信息'],
      ],
    },
  ];

  let pendingCount = $state(0);
  let appPending = $state(0);
  let draftPending = $state(0);
  let authorPending = $state(0);

  /** ≤640px 时侧栏变成抽屉，这个是抽屉开关；换页后自动收起 */
  let navOpen = $state(false);
  const currentLabel = $derived.by(() => {
    for (const g of NAV) {
      for (const [href, , label] of g.items) if (page.url.pathname === href) return label;
    }
    return 'Zero 后台';
  });

  $effect(() => {
    page.url.pathname;
    navOpen = false;
  });

  $effect(() => {
    if (isLogin) return;
    if (!session.checked) {
      void session.refresh().then(() => {
        if (!session.user) goto('/login');
      });
    }
  });

  $effect(() => {
    if (!isAdmin) return;
    // 读取 pathname 只为建立依赖：切换页面时立刻刷新待审核角标
    page.url.pathname;
    let stop = false;
    const tick = async () => {
      try {
        const [d, apps, drafts, authors] = await Promise.all([
          get<{ data: { count: number } }>('/api/comments/pending-count'),
          get<{ data: { pending?: number } }>('/api/admin/applications/stats'),
          get<{ data: { pending?: number } }>('/api/admin/drafts/stats'),
          get<{ data: { items?: { status: string }[] } }>('/api/admin/author-requests?status=pending'),
        ]);
        if (stop) return;
        pendingCount = d.data.count ?? 0;
        appPending = apps.data.pending ?? 0;
        draftPending = drafts.data.pending ?? 0;
        authorPending = authors.data.items?.length ?? 0;
      } catch {}
    };
    void tick();
    // 角标不是实时数据：60 秒一轮四次请求，后台全天挂着就是上千次 Worker 请求；
    // 5 分钟一次，加上切换页面时立刻重读，够用又省额度
    const t = setInterval(tick, 300_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  });

  async function logout() {
    try {
      await post('/api/auth/logout');
    } catch {}
    session.logout();
    goto('/login');
  }
</script>

{#if denied}
  <div class="bare">
    <main class="bare-main nf">
      <p class="code">404</p>
      <p class="msg">页面不存在。</p>
    </main>
    <footer class="copy">{copyright}</footer>
  </div>
{:else if isLogin}
  <!-- 这一支只有 /login（公开页）。以前外面是个 <div>，于是 axe 报两条：
       「整页没有一个 <main>」+「7 处内容不在任何 landmark 里」—— 读屏用户在登录页只能靠 Tab 走。
       换成 <main> 一次把两类都消掉：样式仍走同一个 .bare-main 类，视觉与位置不动。 -->
  <div class="bare">
    <main class="bare-main">
      <h1 class="sr-only">Zero 管理后台 · 登录</h1>
      {@render children()}
    </main>
    <footer class="copy">{copyright}</footer>
  </div>
{:else if !ready || !session.user}
  <!-- 会话还没确认（或确认下来没登录）时不挂页面组件：后台只有 /login 是公开页，
      而页面一挂上去就发自己那条管理接口请求 —— 匿名打开 /users 会先吃一次注定 401 的调用。
      这一支只持续到 redirect 落地，界面上就是本来那句提示。 -->
  <div class="boot">正在验证登录状态…</div>
{:else}
  <div class="shell">
    <button
      class="scrim"
      class:show={navOpen}
      onclick={() => (navOpen = false)}
      aria-label="关闭菜单"
      tabindex={navOpen ? 0 : -1}></button>
    <aside class:open={navOpen}>
      <div class="brand">Zero 后台</div>
      <nav>
        {#each NAV as g (g.title)}
          <div class="grp">{g.title}</div>
          {#each g.items as [href, icon, label] (href)}
            <a href={href} class:active={page.url.pathname === href} title={label}>
              <svg
                class="ico"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true">{@html I[icon] ?? ''}</svg>
              <span class="txt">{label}</span>
              {#if href === '/comments' && pendingCount > 0}<i class="cnt">{pendingCount}</i>{/if}
              {#if href === '/friends' && appPending > 0}<i class="cnt">{appPending}</i>{/if}
              {#if href === '/drafts' && draftPending > 0}<i class="cnt">{draftPending}</i>{/if}
              {#if href === '/author-verify' && authorPending > 0}<i class="cnt">{authorPending}</i>{/if}
            </a>
          {/each}
        {/each}
      </nav>
      <div class="foot">
        <span class="who">{session.user?.name || session.user?.email}</span>
        <button class="sm" onclick={logout}>退出</button>
      </div>
    </aside>
    <div class="body">
      <header class="bar">
        <button class="burger" onclick={() => (navOpen = !navOpen)} aria-label="打开菜单">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6" /><line
              x1="3"
              y1="12"
              x2="21"
              y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
        </button>
        <span class="cur">{currentLabel}</span>
        <button class="sm out" onclick={logout}>退出</button>
      </header>
      <main>
        <!-- 页面自己的标题是 <h2>（19 个后台页都是这个结构，改它会动到各页 scoped 样式），
             这里补一个只给读屏的 <h1>：顶栏那行当前栏目名跟着走，每页的标题层级就顺了。 -->
        <h1 class="sr-only">Zero 管理后台 · {currentLabel}</h1>
        {@render children()}
        <footer class="copy">{copyright}</footer>
      </main>
    </div>
  </div>
{/if}

<style>
  .nf {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
  }
  .nf .code {
    margin: 0;
    font-size: 3.2rem;
    font-weight: 700;
    color: var(--muted);
  }
  .nf .msg {
    margin: 0;
    font-size: 0.9rem;
    color: var(--muted);
  }
  .boot {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    min-height: 100dvh;
    color: var(--muted);
  }
  .shell {
    display: flex;
    min-height: 100vh;
    min-height: 100dvh;
  }
  .bare {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
  }
  .bare-main {
    flex: 1;
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  aside {
    width: 208px;
    flex-shrink: 0;
    background: #eef2e6;
    color: #3f5138;
    border-right: 1px solid #dbe4cd;
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100vh;
    /* 手机浏览器的地址栏会改变可视高度，用 dvh 才不会让侧栏比屏幕还长 */
    height: 100dvh;
  }
  .brand {
    font-weight: 700;
    font-size: 1.02rem;
    color: #2f4a2a;
    padding: 1.1rem 1.2rem 0.9rem;
  }
  nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 0.6rem 0.6rem;
    overflow-y: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  nav::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
  }
  nav .grp {
    font-size: 0.7rem;
    color: #5a6b4f;
    letter-spacing: 0.08em;
    padding: 0.7rem 0.7rem 0.2rem;
  }
  nav a {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.7rem;
    border-radius: 8px;
    color: #55684c;
    font-size: 0.9rem;
    position: relative;
  }
  nav a:hover {
    background: #e2ead5;
    color: #2f4a2a;
  }
  nav a.active {
    background: #4f7040;
    color: #fff;
  }
  nav a .txt {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ico {
    width: 16px;
    height: 16px;
    flex: none;
    opacity: 0.8;
  }
  nav a.active .ico {
    opacity: 1;
  }
  .cnt {
    font-style: normal;
    margin-left: auto;
    background: var(--bad);
    color: #fff;
    font-size: 0.7rem;
    border-radius: 999px;
    padding: 0 6px;
  }
  .foot {
    padding: 0.9rem 1.2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border-top: 1px solid #dbe4cd;
    font-size: 0.82rem;
  }
  .who {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .foot button {
    background: transparent;
    color: #55684c;
    border-color: #c7d4b6;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 1.4rem clamp(0.9rem, 3vw, 1.8rem) 1.5rem;
    min-width: 0;
    max-width: 1180px;
    width: 100%;
  }
  .copy {
    padding: 1rem clamp(0.9rem, 3vw, 1.8rem) 1.4rem;
    font-size: 0.78rem;
    color: var(--muted);
    text-align: center;
    /* 内容不满一屏时也被推到底部，页脚始终在视口下沿 */
    margin-top: auto;
  }
  /* 窄屏顶部条：汉堡 + 当前页名 + 退出，默认不占位 */
  .bar {
    display: none;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.8rem;
    background: #eef2e6;
    border-bottom: 1px solid #dbe4cd;
    position: sticky;
    top: 0;
    z-index: 30;
  }
  .bar .cur {
    font-weight: 650;
    color: #2f4a2a;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .burger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    background: transparent;
    border-color: #c7d4b6;
    color: #3f5138;
  }
  .burger svg {
    width: 18px;
    height: 18px;
  }
  .bar .out {
    background: transparent;
    color: #55684c;
    border-color: #c7d4b6;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    border: 0;
    border-radius: 0;
    padding: 0;
    background: rgba(15, 23, 15, 0.38);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s ease;
  }
  .scrim.show {
    opacity: 1;
    pointer-events: auto;
  }

  /* 只有窄到平板竖屏这个量级才收成图标条：1366×768 这类笔记本
     在系统缩放下视口常常是 900～1100px，菜单不能突然只剩图标 */
  @media (max-width: 780px) {
    aside {
      width: 58px;
    }
    .brand {
      display: none;
    }
    nav {
      padding: 0.5rem 0.35rem;
    }
    nav a {
      justify-content: center;
      gap: 0;
      padding: 0.55rem 0;
    }
    nav a .txt {
      display: none;
    }
    nav .grp {
      font-size: 0;
      padding: 0.7rem 0.4rem 0.25rem;
    }
    nav .grp::after {
      content: '';
      display: block;
      height: 1px;
      background: #d3ddc4;
    }
    .cnt {
      position: absolute;
      top: 1px;
      right: 3px;
      margin: 0;
      padding: 0 4px;
      font-size: 0.62rem;
    }
    .foot {
      padding: 0.7rem 0.5rem;
      justify-content: center;
    }
    .foot .who {
      display: none;
    }
  }

  /* 手机：侧栏移出画面，由顶部条的汉堡拉出来 */
  @media (max-width: 640px) {
    aside {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 40;
      width: 232px;
      height: 100dvh;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      /* 收起时移出可聚焦序列，Tab 不会跳进看不见的菜单 */
      visibility: hidden;
      transition:
        transform 0.2s ease,
        visibility 0s linear 0.2s;
      box-shadow: 0 0 24px rgba(0, 0, 0, 0.16);
    }
    aside.open {
      transform: none;
      visibility: visible;
      transition: transform 0.2s ease;
    }
    .brand {
      display: block;
    }
    nav a {
      justify-content: flex-start;
      gap: 0.6rem;
      padding: 0.6rem 0.7rem;
      min-height: 42px;
    }
    nav a .txt {
      display: block;
    }
    nav .grp {
      font-size: 0.7rem;
      padding: 0.7rem 0.7rem 0.2rem;
    }
    nav .grp::after {
      display: none;
    }
    .cnt {
      position: static;
      margin-left: auto;
      padding: 0 6px;
      font-size: 0.7rem;
    }
    .foot {
      padding: 0.9rem 1.2rem;
      justify-content: space-between;
    }
    .foot .who {
      display: block;
    }
    .bar {
      display: flex;
    }
    /* 抽屉之外没有粘性侧栏，正文自己滚 */
    .body {
      min-width: 0;
      width: 100%;
    }
    main {
      padding-top: 0.9rem;
    }
  }
</style>
