<script lang="ts">
  import MediaPicker from '../content/MediaPicker.svelte';
  import { frontUrl } from '#lib/session.svelte';
  import { LIMIT, type SiteSection } from './types';

  let { site }: { site: SiteSection } = $props();

  /** 预览图地址：站内相对路径（/img/bj.png）在后台自己的域名下没有这些文件，
      必须拼站点前台地址；拼不出（siteUrl 没配）就退回文字，不给一张碎图。 */
  function previewSrc(v: string): string {
    const s = v.trim();
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : frontUrl(s);
  }

  let pickLogo = $state(false);
  let pickFavicon = $state(false);
  let pickOg = $state(false);
  let pickLanding = $state(false);

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
  <div class="grid2">
    <label>
      站点名
      <input bind:value={site.name} maxlength={LIMIT.short} placeholder="你的站点名" />
    </label>
    <label>
      导航栏名称（留空同站点名）
      <input bind:value={site.navName} maxlength={LIMIT.short} />
    </label>
  </div>
  <label>
    站点主地址
    <input bind:value={site.siteUrl} maxlength={LIMIT.href} placeholder="https://example.com" />
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
    <label>
      分享图
      <div class="row">
        <input bind:value={site.ogImage} maxlength={LIMIT.href} placeholder="/img/bj.webp" />
        <button class="sm ghost" onclick={() => (pickOg = true)}>选媒体</button>
      </div>
    </label>
    <label>
      落地页背景图
      <div class="row">
        <input bind:value={site.landingImage} maxlength={LIMIT.href} placeholder="/img/bj.png" />
        <button class="sm ghost" onclick={() => (pickLanding = true)}>选媒体</button>
      </div>
      {#if site.landingImage.trim()}
        {@const pv = previewSrc(site.landingImage)}
        {#if pv}<img class="thumb" src={pv} alt="落地页背景图预览" />{/if}
      {/if}
    </label>
  </div>
</section>

<section class="card blk">
  <h3>简介与关键词</h3>
  <label>
    站点简介
    <textarea rows="3" bind:value={site.description} maxlength={LIMIT.long}></textarea>
    <span class="muted small cnt">{site.description.length}/{LIMIT.long} 字</span>
  </label>
  <label>
    关键词（逗号分隔，最多 40 个）
    <input value={keywordsText} oninput={(e) => setKeywords(e.currentTarget.value)} placeholder="个人博客, 技术分享, 摄影" />
  </label>
</section>

<MediaPicker bind:open={pickLogo} title="选择 Logo" onpick={(url) => (site.logo = url)} />
<MediaPicker bind:open={pickFavicon} title="选择 favicon" onpick={(url) => (site.favicon = url)} />
<MediaPicker bind:open={pickOg} title="选择分享图" onpick={(url) => (site.ogImage = url)} />
<MediaPicker bind:open={pickLanding} title="选择落地页背景图" onpick={(url) => (site.landingImage = url)} />

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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.6rem 0.8rem;
    align-items: start;
  }
  .row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .row input {
    flex: 1 1 auto;
    min-width: 0;
  }
  @media (max-width: 720px) {
    .grid2 {
      grid-template-columns: 1fr;
    }
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
    background: var(--panel-2);
  }
</style>
