<script lang="ts">
  import MediaPicker from '../content/MediaPicker.svelte';
  import { LIMIT, type SiteSection } from './types';

  let { site }: { site: SiteSection } = $props();

  let pickLogo = $state(false);
  let pickFavicon = $state(false);
  let pickOg = $state(false);

  /** 关键词在接口里是数组，界面上用一行逗号分隔更好改 */
  let keywordsText = $derived(site.keywords.join('，'));
  function setKeywords(v: string) {
    site.keywords = v
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40);
  }
</script>

<section class="card blk">
  <h3>站点名称</h3>
  <p class="muted small">
    这一份写进站点 <code>data/site.json</code>，主题读它优先、读不到才回落到 <code>params.toml</code> 顶层的
    <code>navName / site_name / logo / favicon / author / default_author / description / keywords</code>。
  </p>
  <div class="grid2">
    <label>
      站点名（导航栏、浏览器标题、分享卡片都用它）
      <input bind:value={site.name} maxlength={LIMIT.short} placeholder="你的站点名" />
    </label>
    <label>
      导航栏里显示的名字（留空则与站点名相同）
      <input bind:value={site.navName} maxlength={LIMIT.short} />
    </label>
  </div>
  <label>
    站点主地址（邮件里的确认 / 退订链接前缀、后台仪表盘的跳转都用它）
    <input bind:value={site.siteUrl} maxlength={LIMIT.href} placeholder="https://example.com" />
    <span class="muted small cnt">要与 <code>config.toml</code> 的 <code>baseURL</code> 写成同一个地址；保存时会同步进配置键 siteUrl。</span>
  </label>
  <div class="row sws">
    <label class="switch"><input type="checkbox" bind:checked={site.showLogo} /><span>导航栏显示 Logo</span></label>
    <label class="switch"><input type="checkbox" bind:checked={site.showName} /><span>导航栏显示站点名</span></label>
  </div>
</section>

<section class="card blk">
  <h3>图片与图标</h3>
  <div class="grid2">
    <label>
      Logo 地址
      <div class="row">
        <input bind:value={site.logo} maxlength={LIMIT.href} placeholder="/img/logo-nav.webp" />
        <button class="sm ghost" onclick={() => (pickLogo = true)}>选媒体</button>
      </div>
    </label>
    <label>
      浏览器图标（favicon）
      <div class="row">
        <input bind:value={site.favicon} maxlength={LIMIT.href} placeholder="/img/logo-favicon.png" />
        <button class="sm ghost" onclick={() => (pickFavicon = true)}>选媒体</button>
      </div>
    </label>
  </div>
  <label>
    分享图（文章没有封面时，社交平台卡片用的那一张；留空回落到 Logo）
    <div class="row">
      <input bind:value={site.ogImage} maxlength={LIMIT.href} placeholder="/img/bj.webp" />
      <button class="sm ghost" onclick={() => (pickOg = true)}>选媒体</button>
    </div>
  </label>
  <p class="muted small">
    填站内路径（<code>/img/xxx.webp</code>，对应站点 static 目录）或完整 <code>https://</code> 外链都行。
    {#if site.logo.trim()}
      当前 Logo：<img class="thumb" src={site.logo.trim()} alt="logo 预览" />
    {:else}
      当前没填 Logo，前台用主题自带的 img/logo-nav.webp。
    {/if}
  </p>
</section>

<section class="card blk">
  <h3>简介与关键词</h3>
  <label>
    站点简介（搜索引擎与分享卡片的默认描述）
    <textarea rows="3" bind:value={site.description} maxlength={LIMIT.long}></textarea>
    <span class="muted small cnt">{site.description.length}/{LIMIT.long} 字</span>
  </label>
  <label>
    关键词（逗号分隔，最多 40 个）
    <input value={keywordsText} oninput={(e) => setKeywords(e.currentTarget.value)} placeholder="个人博客, 技术分享, 摄影" />
  </label>
  <p class="muted small">
    站点主域名（baseURL）与 Hugo 的 <code>title</code> 属于 <code>config.toml</code>，这一页不碰；
    要改请用最后一个「主题配置文件」子标签整份编辑。
  </p>
</section>

<MediaPicker bind:open={pickLogo} title="选择 Logo" onpick={(url) => (site.logo = url)} />
<MediaPicker bind:open={pickFavicon} title="选择 favicon" onpick={(url) => (site.favicon = url)} />
<MediaPicker bind:open={pickOg} title="选择分享图" onpick={(url) => (site.ogImage = url)} />

<style>
  .blk {
    margin-bottom: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .blk h3 {
    margin: 0;
    font-size: 0.98rem;
  }
  .grid2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0.5rem;
  }
  .row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .sws {
    flex-wrap: wrap;
    gap: 0.8rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.88rem;
    color: var(--fg);
  }
  .cnt {
    font-size: 0.72rem;
  }
  .thumb {
    height: 28px;
    width: auto;
    vertical-align: middle;
    margin-left: 0.3rem;
    border-radius: 4px;
    background: #f3f4f6;
  }
</style>
