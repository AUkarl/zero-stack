<script lang="ts">
  import MediaPicker from '../content/MediaPicker.svelte';
  import { frontUrl } from '#lib/session.svelte';
  import { LIMIT, type SiteSection } from './types';

  let { site }: { site: SiteSection } = $props();

  /** 预览图地址：站内相对路径（/img/bj.png）在后台自己的域名下没有这些文件，
      必须拼站点前台地址；拼不出（siteUrl 没配）就退回文字，不给一张碎图。
      协议相对地址（//cdn…）和 data:/blob: 原样交给浏览器，别在前面加站点域名。 */
  function previewSrc(v: string): string {
    const s = v.trim();
    if (!s) return '';
    if (/^(https?:)?\/\//i.test(s) || /^(data|blob):/i.test(s)) return s;
    const base = (site.siteUrl || '').trim().replace(/\/+$/, '');
    if (base) return base + (s.startsWith('/') ? s : '/' + s);
    return frontUrl(s);
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

{#snippet preview(url: string, wide: boolean)}
  {@const pv = previewSrc(url)}
  {#if pv}
    <span class="pv {wide ? 'wide' : 'icon'}">
      <img
        src={pv}
        alt="图片预览"
        loading="lazy"
        onerror={(e) => {
          const img = e.currentTarget as HTMLImageElement;
          img.hidden = true;
          img.style.display = 'none';
          const fail = img.nextElementSibling as HTMLElement | null;
          if (fail) fail.hidden = false;
        }}
      />
      <span class="pv-fail" hidden>图片加载失败</span>
    </span>
  {/if}
{/snippet}

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
      {@render preview(site.logo, false)}
    </label>
    <label>
      浏览器图标（favicon）
      <div class="row">
        <input bind:value={site.favicon} maxlength={LIMIT.href} placeholder="/img/logo-favicon.png" />
        <button class="sm ghost" onclick={() => (pickFavicon = true)}>选媒体</button>
      </div>
      {@render preview(site.favicon, false)}
    </label>
    <label>
      分享图
      <div class="row">
        <input bind:value={site.ogImage} maxlength={LIMIT.href} placeholder="/img/bj.webp" />
        <button class="sm ghost" onclick={() => (pickOg = true)}>选媒体</button>
      </div>
      {@render preview(site.ogImage, true)}
    </label>
    <label>
      落地页背景图
      <div class="row">
        <input bind:value={site.landingImage} maxlength={LIMIT.href} placeholder="/img/bj.png" />
        <button class="sm ghost" onclick={() => (pickLanding = true)}>选媒体</button>
      </div>
      {@render preview(site.landingImage, true)}
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
  /* 预览容器：宽图按 16:9 附近的高度裁切，图标按原比例装进固定盒子。
     以前只给 28px 高，超宽背景图会被压成一条线；现在桌面上约 160px、手机上约 110px。 */
  .pv {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    margin-top: 0.35rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background:
      repeating-conic-gradient(var(--panel-2) 0 25%, transparent 0 50%) 0 0 / 14px 14px;
    box-sizing: border-box;
  }
  .pv.wide {
    height: clamp(110px, 32vw, 170px);
  }
  .pv.icon {
    width: 180px;
    max-width: 100%;
    height: 76px;
    padding: 6px;
  }
  .pv img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .pv.icon img {
    object-fit: contain;
  }
  .pv-fail {
    display: block;
    padding: 0.3rem 0.5rem;
    color: var(--muted);
    font-size: 0.74rem;
    text-align: center;
  }
  .pv-fail[hidden] {
    display: none;
  }
</style>
