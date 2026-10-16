<script lang="ts">
  import { page } from '$app/state';

  /**
   * 后台自己的 404。
   *
   * 为什么必须有这一页：后台是纯静态 SPA，Pages 的函数把「任何不认识的路径」都接住，
   * 没有这一页时 SvelteKit 只会回一句光秃秃的 Not Found；而后台里指向文章的链接以前直接写
   * `/posts/xxx`，在后台域名下解析就是这个页面，看着像「后台坏了」。
   * 现在链接都拼站点前台地址（设置里的 siteUrl），真走错时也能一键回去。
   */
  const path = $derived(page.url.pathname);
</script>

<div class="wrap">
  <h1>后台没有这个页面</h1>
  <p class="muted">
    地址 <code>{path}</code> 在后台里不存在。要看文章本身请去站点前台；
    后台的功能都在左侧菜单里，或者回首页。
  </p>
  <p>
    <a class="primary" href="/">回后台首页</a>
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
</style>
