<script lang="ts">
  import { page } from '$app/state';

  /**
   * 后台的错误页。
   *
   * 为什么要分状态码写：这一页原先对任何错误都说「地址 X 在后台里不存在」，
   * 于是一个 500（页面组件渲染时抛异常、或部署后浏览器还拿着旧的入口文件去请已经被换掉的代码包）
   * 看上去就跟真的走错地址一模一样 —— 明明是「这一页挂了」，却被读成「后台没这个功能」，
   * 排查方向整个被带偏。现在把真实状态码和消息都摊出来，再给一个绕开缓存的重载按钮。
   *
   * 后台是纯静态 SPA，Pages 的函数把「任何不认识的路径」都接住，没有这一页时 SvelteKit
   * 只会回一句光秃秃的 Not Found；后台里指向文章的链接以前直接写 `/posts/xxx`，
   * 在后台域名下解析就是这个页面，看着像「后台坏了」。现在链接都拼站点前台地址（设置里的 siteUrl）。
   */
  const path = $derived(page.url.pathname);
  const status = $derived(page.status);
  /** page.error 的类型是 App.ErrorMessage，默认就是 unknown 形状，取 message 得先收窄 */
  const message = $derived(String((page.error as { message?: string } | null)?.message ?? ''));
  const is404 = $derived(status === 404);
</script>

<div class="wrap">
  <h1>{is404 ? '后台没有这个页面' : `后台这一页出错了（${status}）`}</h1>
  {#if is404}
    <p class="muted">
      地址 <code>{path}</code> 在后台里不存在。要看文章本身请去站点前台；
      后台的功能都在左侧菜单里，或者回首页。
    </p>
  {:else}
    <p class="muted">
      访问 <code>{path}</code> 时后端或页面本身报了 <code>{status}</code>。
      {#if message}原因：<code>{message}</code>{/if}
      刚重新部署过后台的话，先点下面那个「绕开缓存重新载入」——旧页面手里那份代码清单可能已经对不上新的文件了。
    </p>
  {/if}
  <p class="row">
    <button type="button" class="primary" onclick={() => window.location.reload()}>绕开缓存重新载入</button>
    <a href="/">回后台首页</a>
  </p>
</div>

<style>
  .wrap {
    max-width: 40rem;
    margin: 4rem auto;
    padding: 0 1rem;
  }
  code {
    word-break: break-all;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    align-items: center;
  }
</style>
