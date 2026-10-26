<script lang="ts">
  import { get, post, timeAgo } from '#lib/api';
  import { renderMarkdown } from '#lib/markdown';
  import { frontUrl } from '#lib/session.svelte';

  interface Row {
    id: string;
    postSlug: string;
    /** 接口按文章号从内容仓库的 front matter 认出来的标题；认不到为空，界面回落到地址 */
    postTitle?: string;
    content: string;
    authorName: string;
    authorEmail: string | null;
    status: string;
    createdAt: number;
    depth: number;
    isLegacy?: boolean;
  }

  let rows = $state<Row[]>([]);
  let filter = $state<'pending' | 'approved' | 'spam' | 'all'>('pending');
  let loading = $state(false);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      const d = await get<{ data: Row[] }>(`/api/admin/comments?status=${filter}`);
      rows = d.data;
    } catch (e) {
      error = e instanceof Error ? e.message : '加载失败';
    } finally {
      loading = false;
    }
  }

  $effect(() => void load());

  async function act(id: string, action: 'approve' | 'reject' | 'spam') {
    if (action === 'reject' && !confirm('确定删除该评论及其所有子回复？')) return;
    try {
      await post(`/api/admin/comments/${id}/moderate`, { action });
      rows = rows.filter((r) => r.id !== id);
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : '操作失败';
    }
  }

  const TABS = [
    ['pending', '待审核'],
    ['approved', '已通过'],
    ['spam', '垃圾'],
    ['all', '全部'],
  ] as const;
</script>

<div class="row spread head">
  <h2>评论管理</h2>
  <button onclick={() => void load()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
</div>

<div class="tabs">
  {#each TABS as [key, label] (key)}
    <button class="sm" class:on={filter === key} onclick={() => { filter = key; void load(); }}>{label}</button>
  {/each}
</div>

{#if error}<p class="err">{error}</p>{/if}
{#if rows.length === 0 && !loading}<p class="muted">{filter === 'pending' ? '没有待审核的评论。' : '暂无记录'}</p>{/if}

<div class="list">
  {#each rows as r (r.id)}
    <div class="card item">
      <div class="row spread">
        <div class="who">
          <b>{r.authorName}</b>
          <span class="muted">{r.authorEmail ?? ''}</span>
          {#if r.depth > 1}<span class="badge">第 {r.depth} 层</span>{/if}
          {#if r.isLegacy}<span class="badge pending">迁移</span>{/if}
          <span class="badge" class:good={r.status === 'approved'} class:pending={r.status === 'pending'} class:bad={r.status === 'spam'}>{r.status}</span>
        </div>
        <span class="muted t">{timeAgo(r.createdAt)}</span>
      </div>
      <!-- 正文走评论组件那一份渲染器：表情、加粗、链接、代码在后台和读者那边是一个样。
           渲染器整段先转义 HTML，评论里写的 <script> 只会变成字面文本。 -->
      <div class="content">{@html renderMarkdown(r.content, { shortBase: frontUrl('/posts/') || '/posts/' })}</div>
      <div class="row slug">
        <!-- 先给标题：站长的文章文件名就是日期串，光看地址认不出是哪篇被评论了 -->
        {#if frontUrl(r.postSlug)}
          <a href={frontUrl(r.postSlug)} target="_blank" rel="noreferrer">{r.postTitle || r.postSlug}</a>
        {:else}
          <!-- siteUrl 没配时不做成链接：拼出来的相对路径会在后台自己的域名下 404 -->
          <span class="muted" title="后台「设置 → 站点信息」里的站点地址为空，暂时给不出前台链接">{r.postTitle || r.postSlug}</span>
        {/if}
        {#if r.postTitle}<span class="muted">{r.postSlug}</span>{/if}
      </div>
      <div class="ops">
        {#if r.status !== 'approved'}<button class="sm primary" onclick={() => void act(r.id, 'approve')}>通过</button>{/if}
        {#if r.status !== 'spam'}<button class="sm" onclick={() => void act(r.id, 'spam')}>标为垃圾</button>{/if}
        <button class="sm danger" onclick={() => void act(r.id, 'reject')}>删除</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .head {
    margin-bottom: 0.7rem;
  }
  .tabs {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.9rem;
  }
  .tabs .on {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .item .who {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .item .t {
    font-size: 0.8rem;
  }
  /* 渲染出来的是 <p>/<img> 这些标签，不能再要 pre-wrap —— 那样 HTML 源码里的换行
     会变成第二段空行，每条看起来都像空了一行 */
  .content {
    margin: 0.5rem 0;
    line-height: 1.6;
  }
  .content :global(p) {
    margin: 0.2rem 0;
  }
  .content :global(img.zc-emoji-img) {
    display: inline-block; height: 1.5em; width: auto; max-width: 1.5em;
    vertical-align: -0.3em; margin: 0 0.05em;
  }
  .content :global(.zc-emoji-tok) {
    font-size: 0.82em; color: var(--muted, inherit); word-break: break-all;
  }
  .slug {
    font-size: 0.8rem;
  }
  .ops {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }
</style>
