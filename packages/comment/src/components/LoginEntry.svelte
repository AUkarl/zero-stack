<svelte:options
  customElement={{
    tag: 'zero-login',
    props: {
      apiBase: { attribute: 'api-base', type: 'String' },
      loginHref: { attribute: 'login-href', type: 'String' },
      showEntry: { attribute: 'show-entry', type: 'Boolean' },
      lang: { attribute: 'lang', type: 'String' },
    },
  }}
/>
<script lang="ts">
  import { resolveBase } from '../lib/api';
  import { commentConfig } from '../lib/config.svelte';
  import { tr } from '../lib/i18n';
  import { session } from '../lib/session.svelte';

  /**
   * zero-login — 登录入口按钮（原弹框表单已删：登录统一走站点 /account/ 页）
   *
   * 评论区里的入口由 <zero-comment> 自己出，这个元素只给「没有评论区、又需要一个登录按钮」
   * 的页面用（show-entry 默认关，所以主题里常驻的那个标签不写属性就是什么都不显示）。
   * 显隐跟后台 allowRegister 一致：注册关了就不给普通访客摆登录入口。
   */
  let {
    apiBase = '',
    loginHref = '/account/',
    showEntry = false,
    lang = '',
  }: { apiBase?: string; loginHref?: string; showEntry?: boolean; lang?: string } = $props();

  const base = $derived(resolveBase(apiBase));
  const t = $derived(tr(lang || (typeof document !== 'undefined' ? document.documentElement.lang : '')));

  $effect(() => {
    if (base) session.init(base);
    void commentConfig.load(base);
  });
</script>

{#if showEntry && !session.user && commentConfig.allowRegister && commentConfig.accountSystemEnabled}
  <a class="chip" href={loginHref}>{t('login')}</a>
{/if}

<style>
  /* 颜色走宿主变量，深色换肤下不会出现白底白字 */
  .chip {
    display: inline-block; font: inherit; font-size: 0.85rem; text-decoration: none;
    border: 1px solid var(--border, #e2e2e2); background: var(--card-bg, #fff); color: var(--text-secondary, #444);
    border-radius: 999px; padding: 0.2rem 0.7rem;
  }
  .chip:hover { border-color: var(--logo-accent-text, #0070f3); color: var(--logo-accent-text, #0070f3); }
</style>
