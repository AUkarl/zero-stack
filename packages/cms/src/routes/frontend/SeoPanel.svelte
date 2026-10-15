<script lang="ts">
  import MediaPicker from '../content/MediaPicker.svelte';
  import { LIMIT, type SeoSection } from './types';

  let { seo }: { seo: SeoSection } = $props();

  let pickOg = $state(false);
  let pickPublisher = $state(false);

  /* 多行文本框 <-> 数组：一行一条，空行丢掉。
     外部（「重新读取」/「放弃改动」）换掉整份表单时把文本重新铺回去 —— 判的是数组身份，
     不是内容：自己 oninput 写出去的那一份不再回写，否则打字打一半会被重排。 */
  let keywordsText = $state('');
  let disallowText = $state('');
  let allowText = $state('');
  const seed: { keywords: unknown; disallow: unknown; allow: unknown } = {
    keywords: null,
    disallow: null,
    allow: null,
  };

  $effect(() => {
    if (seed.keywords !== seo.defaultKeywords) {
      seed.keywords = seo.defaultKeywords;
      keywordsText = seo.defaultKeywords.join('\n');
    }
  });
  $effect(() => {
    if (seed.disallow !== seo.robotsDisallow) {
      seed.disallow = seo.robotsDisallow;
      disallowText = seo.robotsDisallow.join('\n');
    }
  });
  $effect(() => {
    if (seed.allow !== seo.robotsAllow) {
      seed.allow = seo.robotsAllow;
      allowText = seo.robotsAllow.join('\n');
    }
  });

  function splitLines(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function syncKeywords() {
    seo.defaultKeywords = splitLines(keywordsText);
    seed.keywords = seo.defaultKeywords;
  }
  function syncDisallow() {
    seo.robotsDisallow = splitLines(disallowText);
    seed.disallow = seo.robotsDisallow;
  }
  function syncAllow() {
    seo.robotsAllow = splitLines(allowText);
    seed.allow = seo.robotsAllow;
  }

  const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const swatch = (v: string) => (HEX.test(v.trim()) ? v.trim() : 'transparent');
</script>

<section class="card blk">
  <h3>这一页管什么</h3>
  <p class="muted small">
    保存写进站点 <code>data/seo.json</code>，主题按「data 优先、<code>params.toml</code> 的 <code>[seo]</code> 兜底」取
    （见 <code>partials/seo-config.html</code>）。想让某一项回到 params 的默认值，就删掉那一项再保存，或者用页面底部的「删除覆盖」。
    改动要等下一次站点构建才生效。
  </p>
</section>

<section class="card blk">
  <h3>描述与标题</h3>
  <label>
    默认描述（页面自己没写描述时用它）
    <textarea rows="3" bind:value={seo.defaultDescription} maxlength={LIMIT.long}></textarea>
    <span class="muted small cnt">{seo.defaultDescription.length}/{LIMIT.long} 字</span>
  </label>
  <label>
    默认关键词（一行一个；页面没写关键词时用它）
    <textarea rows="3" bind:value={keywordsText} oninput={syncKeywords}></textarea>
    <span class="muted small">当前 {seo.defaultKeywords.length} 个，最多 40 个</span>
  </label>
  <div class="grid2">
    <label>
      描述截断长度（40 ~ 400）
      <input type="number" min="40" max="400" bind:value={seo.descriptionLength} />
    </label>
    <label>
      标题分隔符
      <input bind:value={seo.titleSeparator} maxlength="4" placeholder="·" />
    </label>
  </div>
  <p class="muted small">
    拼出来的标题形如：<strong>文章标题{seo.titleSeparator || '·'}站点名</strong>
  </p>
</section>

<section class="card blk">
  <h3>分享图 / 作者兜底</h3>
  <label>
    默认分享图（页面没有封面时用它）
    <div class="row">
      <input bind:value={seo.ogImageDefault} maxlength={LIMIT.href} placeholder="/img/bj.webp" />
      <button class="sm ghost" onclick={() => (pickOg = true)}>选媒体</button>
    </div>
  </label>
  <label>
    出版方 Logo（结构化数据里的 publisher）
    <div class="row">
      <input bind:value={seo.publisherLogo} maxlength={LIMIT.href} placeholder="/img/logo-nav.webp" />
      <button class="sm ghost" onclick={() => (pickPublisher = true)}>选媒体</button>
    </div>
  </label>
  <label>
    默认作者（留空退回「基本信息」里的署名）
    <input bind:value={seo.siteAuthor} maxlength={LIMIT.short} />
  </label>
  <p class="muted small">
    Twitter 站点与创作者账号一般写成 <code>@username</code>，只在开启 Twitter Card 时才会输出。
  </p>
  <div class="grid2">
    <label>站点 Twitter 账号<input bind:value={seo.twitterSite} maxlength={LIMIT.short} placeholder="@你的账号" /></label>
    <label>创作者 Twitter 账号<input bind:value={seo.twitterCreator} maxlength={LIMIT.short} placeholder="@zhizhi" /></label>
  </div>
</section>

<section class="card blk">
  <h3>输出哪些标签</h3>
  <p class="muted small">关掉只是不再输出那一段标签，页面本身不受影响。</p>
  <div class="row sws">
    <label class="switch"><input type="checkbox" bind:checked={seo.enableCanonical} /><span>canonical 规范链接</span></label>
    <label class="switch"><input type="checkbox" bind:checked={seo.enableKeywords} /><span>keywords meta</span></label>
    <label class="switch"><input type="checkbox" bind:checked={seo.enableOg} /><span>Open Graph</span></label>
    <label class="switch"><input type="checkbox" bind:checked={seo.enableTwitter} /><span>Twitter Card</span></label>
    <label class="switch"><input type="checkbox" bind:checked={seo.enableJsonld} /><span>结构化数据 JSON-LD</span></label>
    <label class="switch"><input type="checkbox" bind:checked={seo.enableBreadcrumb} /><span>面包屑结构化数据</span></label>
    <label class="switch"><input type="checkbox" bind:checked={seo.enableSearchAction} /><span>站内搜索 potentialAction</span></label>
  </div>
</section>

<section class="card blk">
  <h3>robots.txt</h3>
  <div class="row sws">
    <label class="switch"><input type="checkbox" bind:checked={seo.enableRobots} /><span>输出 robots 标签</span></label>
    <label class="switch"><input type="checkbox" bind:checked={seo.enableRobotsSitemap} /><span>robots.txt 里带 Sitemap 行</span></label>
  </div>
  <div class="grid2">
    <label>
      默认指令
      <input bind:value={seo.robotsDefault} maxlength={LIMIT.short} placeholder="index, follow" />
    </label>
    <label>
      抓取延迟（秒，0 为不输出）
      <input type="number" min="0" max="100" bind:value={seo.robotsCrawlDelay} />
    </label>
    <label>
      Host 行（留空不输出）
      <input bind:value={seo.robotsHost} maxlength={LIMIT.href} placeholder="https://example.com" />
    </label>
  </div>
  <div class="grid2">
    <label>
      禁止路径（一行一个，要以 / 开头）
      <textarea rows="3" bind:value={disallowText} oninput={syncDisallow}></textarea>
    </label>
    <label>
      允许路径（一行一个）
      <textarea rows="3" bind:value={allowText} oninput={syncAllow}></textarea>
    </label>
  </div>
  <pre class="pv">User-agent: *{#each seo.robotsAllow as p}
Allow: {p}{/each}{#each seo.robotsDisallow as p}
Disallow: {p}{/each}{#if seo.robotsCrawlDelay > 0}
Crawl-delay: {seo.robotsCrawlDelay}{/if}{#if seo.enableRobotsSitemap}
Sitemap: （站点地址）/sitemap.xml{/if}{#if seo.robotsHost.trim()}
Host: {seo.robotsHost.trim()}{/if}</pre>
</section>

<section class="card blk">
  <h3>浏览器配色</h3>
  <div class="grid2">
    <label>
      浅色主题色
      <div class="row">
        <input bind:value={seo.themeColorLight} maxlength="9" placeholder="#ffffff" />
        <span class="chip-color" style="background:{swatch(seo.themeColorLight)}" aria-hidden="true"></span>
      </div>
    </label>
    <label>
      深色主题色
      <div class="row">
        <input bind:value={seo.themeColorDark} maxlength="9" placeholder="#1e1e1e" />
        <span class="chip-color" style="background:{swatch(seo.themeColorDark)}" aria-hidden="true"></span>
      </div>
    </label>
    <label>
      color-scheme
      <input bind:value={seo.colorScheme} maxlength={LIMIT.short} placeholder="light dark" />
    </label>
  </div>
  <p class="muted small">
    两个色值都要写成 <code>#fff</code> 或 <code>#ffffff</code>；填错会被下面的校验拦住。
    {#if !HEX.test(seo.themeColorLight.trim()) || !HEX.test(seo.themeColorDark.trim())}
      <span class="err">当前有不是十六进制的值。</span>
    {/if}
  </p>
</section>

<MediaPicker bind:open={pickOg} title="选择默认分享图" onpick={(url) => (seo.ogImageDefault = url)} />
<MediaPicker bind:open={pickPublisher} title="选择出版方 Logo" onpick={(url) => (seo.publisherLogo = url)} />

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
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 0.5rem;
  }
  .row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .sws {
    flex-wrap: wrap;
    gap: 0.9rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.88rem;
    color: var(--fg);
  }
  .cnt,
  .muted {
    font-size: 0.76rem;
  }
  .pv {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    font-size: 0.78rem;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-x: auto;
    background: var(--bg, transparent);
  }
  .chip-color {
    width: 1.4rem;
    height: 1.4rem;
    flex: 0 0 auto;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .err {
    color: var(--danger, #c0392b);
  }
</style>
