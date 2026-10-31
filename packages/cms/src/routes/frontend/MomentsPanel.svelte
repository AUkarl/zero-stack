<script lang="ts">
  import MediaPicker from '../content/MediaPicker.svelte';
  import { get, patch } from '#lib/api';
  import { LIMIT, type MomentsSection } from './types';

  let { moments }: { moments: MomentsSection } = $props();

  let pickBanner = $state(false);
  let pickAvatar = $state(false);

  /* 时刻评论系统：这一项存 site_config（运行时生效，不用重建站点），
     不像本页其余各段落进 data/moments.json，所以走自己的读取与保存。 */
  const PROVIDERS = [
    { value: 'zero', label: 'Zero 自带' },
    { value: 'waline', label: 'Waline' },
    { value: 'twikoo', label: 'Twikoo' },
    { value: 'giscus', label: 'Giscus' },
    { value: 'artalk', label: 'Artalk' },
  ];

  let provider = $state('zero');
  let providerSaved = $state('');
  let providerLoaded = $state(false);
  let providerBusy = $state(false);
  let providerNote = $state('');

  $effect(() => {
    void loadProvider();
  });

  async function loadProvider() {
    try {
      const d = await get<{ data: Record<string, string> }>('/api/admin/config');
      provider = d.data.momentCommentProvider || 'zero';
      providerSaved = provider;
      providerLoaded = true;
    } catch {
      // 读不到就停在默认值上，不拦本页其它段的编辑，也只是这一项不能保存
      providerLoaded = false;
    }
  }

  async function saveProvider() {
    if (providerBusy || provider === providerSaved) return;
    providerBusy = true;
    providerNote = '';
    try {
      await patch('/api/admin/config', { momentCommentProvider: provider });
      providerSaved = provider;
      providerNote = '已保存，前台 60 秒内生效，不用重新构建站点';
    } catch (e) {
      providerNote = e instanceof Error ? e.message : '保存失败';
    } finally {
      providerBusy = false;
    }
  }
</script>

<section class="card blk">
  <h3>时刻页开关与列表</h3>
  <p class="muted small">
    这一份写进站点 <code>data/moments.json</code>，主题读它优先、读不到才回落到 <code>params.toml</code> 的 <code>[moment]</code>。
    每条时刻自己的正文、配图、位置在 <code>content/zh/moments/*.md</code> 里，去「时刻」那页发。
  </p>
  <label class="num">
    每批加载几条（无限滚动，一次拉一批）
    <input type="number" min="1" max="100" bind:value={moments.paginate} />
  </label>
</section>

<section class="card blk">
  <h3>位置</h3>
  <label class="switch">
    <input type="checkbox" bind:checked={moments.showLocation} />
    <span>卡片底栏显示位置（发布时刻时填的「地点」）</span>
  </label>
  <label>
    没填地点时的兜底文案（留空就只显示填了的）
    <input bind:value={moments.defaultLocation} maxlength={LIMIT.short} placeholder="线上" />
  </label>
</section>

<section class="card blk">
  <h3>顶部横幅</h3>
  <label class="switch">
    <input type="checkbox" bind:checked={moments.bannerShowBackground} />
    <span>显示横幅背景图（关掉就压成一条紧凑的浅色身份栏；下面的头像、昵称也一起关掉时，整块横幅不再出现）</span>
  </label>
  <label>
    背景图地址
    <div class="row">
      <input bind:value={moments.bannerImage} maxlength={LIMIT.href} placeholder="img/bj2.webp" />
      <button class="sm ghost" onclick={() => (pickBanner = true)}>选媒体</button>
    </div>
  </label>
</section>

<section class="card blk">
  <h3>顶部身份栏</h3>
  <div class="row sws">
    <label class="switch"><input type="checkbox" bind:checked={moments.showAvatar} /><span>头像</span></label>
    <label class="switch"><input type="checkbox" bind:checked={moments.showNickname} /><span>昵称</span></label>
  </div>
  <div class="grid2">
    <label>
      昵称（卡片右上角的署名也用这一个）
      <input bind:value={moments.nickname} maxlength={LIMIT.short} placeholder="站长昵称" />
    </label>
  </div>
  <label>
    头像地址
    <div class="row">
      <input bind:value={moments.avatar} maxlength={LIMIT.href} placeholder="img/avatar.webp" />
      <button class="sm ghost" onclick={() => (pickAvatar = true)}>选媒体</button>
    </div>
  </label>
  <p class="muted small">
    这一页前面的改动写进 <code>data/moments.json</code>，要等下一次站点构建才生效；只有下面「时刻评论区」那项是运行时配置，保存就生效。
  </p>
</section>

<section class="card blk">
  <h3>时刻评论区</h3>
  <label>
    用哪套评论系统
    <div class="row">
      <select bind:value={provider}>
        {#each PROVIDERS as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
      </select>
      <button
        class="sm"
        onclick={() => void saveProvider()}
        disabled={providerBusy || !providerLoaded || provider === providerSaved}
      >{providerBusy ? '保存中…' : providerLoaded && provider === providerSaved ? '已保存' : '保存这一项'}</button>
    </div>
  </label>
  <p class="muted small">
    它存的是后台配置（<code>momentCommentProvider</code>），不参与底部那个统一按钮；文章评论区在「设置 → 评论」里选，
    选第三方时它的参数也在那一页的「第三方评论参数（JSON）」里填。
  </p>
  {#if providerNote}<p class="muted small">{providerNote}</p>{/if}
</section>

<MediaPicker bind:open={pickBanner} title="选择横幅背景图" onpick={(url) => (moments.bannerImage = url)} />
<MediaPicker bind:open={pickAvatar} title="选择头像" onpick={(url) => (moments.avatar = url)} />

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
    grid-template-columns: var(--t-4);
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
  .num input {
    width: 120px;
  }
</style>
