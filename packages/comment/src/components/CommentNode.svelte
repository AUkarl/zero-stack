<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Comment, CommentCtx } from './types';
  import { timeAgo } from '../lib/api';
  import { tr } from '../lib/i18n';
  import { avatarSources, fallbackStyle, infoLine, initialOf, safeLink } from '../lib/meta';
  import { hasOwnerKey } from '../lib/owners';
  import { session } from '../lib/session.svelte';
  import CommentEditor from './CommentEditor.svelte';
  import Markdown from './Markdown.svelte';
  import type { EmojiPack } from '../lib/emoji-packs';

  /**
   * CommentNode — 一条评论（顶层或平铺出来的一级回复都用它）
   *
   * 三行结构：
   *   1. 头像（左列）＋ 昵称 ＋ 用户组 ＋「回复 @某人」＋ 点赞 回复 编辑 删除（窄屏折行，不竖排）
   *   2. 正文（缩进在昵称下方）
   *   3. 时间 · 位置 · 浏览器 · 系统（小一号次要文字）
   * 回复不再按 depth 嵌套渲染，所以这里没有 children 递归。
   */
  let {
    node,
    ctx,
    shortBase = '/posts/',
    slug = '',
    lang = '',
    showMeta = true,
    likeEnabled = true,
    packs = [] as EmojiPack[],
    identity,
  }: {
    node: Comment;
    ctx: CommentCtx;
    shortBase?: string;
    slug?: string;
    lang?: string;
    showMeta?: boolean;
    likeEnabled?: boolean;
    packs?: EmojiPack[];
    /** 游客回复/编辑时的昵称邮箱网址那几行，由 CommentSection 传同一段片段下来 */
    identity?: Snippet;
  } = $props();

  const t = $derived(tr(lang));

  /** 能不能改/删：登录作者本人、管理员，或本地持有这条的 ownerKey */
  const mine = $derived(
    Boolean(session.user && (session.user.id === node.authorId || session.isAdmin())) ||
      Boolean(node.ownerKey) ||
      hasOwnerKey(slug, node.id),
  );

  /* 头像三级退化：后端 avatar → 邮箱 md5 的 cravatar/gravatar → 首字母色块（img onerror 依次降级） */
  let step = $state(0);
  const sources = $derived(avatarSources(node));
  const avatarSrc = $derived(sources[step] ?? '');

  const linkHref = $derived(safeLink(node.authorLink));
  const displayName = $derived(node.authorName || t('anonymous'));
  const replyToName = $derived(String(node.replyToName || '').trim());
  const isReply = $derived(Boolean(node.parentId));
  const info = $derived(showMeta ? infoLine(node, lang) : '');
  const pending = $derived(node.status === 'pending');
  const edited = $derived(Boolean(node.editedAt));
  const likeCount = $derived(Number(node.likeCount ?? 0));

  /** 身份只用文字标签：站长 / 共创 / 朋友，游客没有 */
  const groupLabel = $derived(
    node.group === 'admin' ? t('groupAdmin') : node.group === 'coauthor' ? t('groupCoauthor') : node.group === 'friend' ? t('groupFriend') : '',
  );

  let likeBusy = $state(false);
  let likeError = $state('');

  async function toggleLike() {
    if (likeBusy) return;
    likeBusy = true;
    likeError = '';
    try {
      await ctx.like(node);
    } catch (e) {
      likeError = e instanceof Error ? e.message : t('likeTitle');
    } finally {
      likeBusy = false;
    }
  }
</script>

<article class="node" class:is-pending={pending} class:is-reply={isReply}>
  <div class="avatar-col">
    {#if linkHref}
      <a href={linkHref} target="_blank" rel="nofollow ugc noopener" title={node.authorLink ?? ''}>
        {#if avatarSrc}
          <img class="avatar" src={avatarSrc} alt="" loading="lazy" onerror={() => (step = step + 1)} />
        {:else}
          <span class="avatar fallback" style={fallbackStyle(node.authorName, node.emailDomain)} aria-hidden="true">
            {initialOf(node.authorName, node.emailDomain)}
          </span>
        {/if}
      </a>
    {:else if avatarSrc}
      <img class="avatar" src={avatarSrc} alt="" loading="lazy" onerror={() => (step = step + 1)} />
    {:else}
      <span class="avatar fallback" style={fallbackStyle(node.authorName, node.emailDomain)} aria-hidden="true">
        {initialOf(node.authorName, node.emailDomain)}
      </span>
    {/if}
  </div>

  <div class="main">
    <!-- 第一行：昵称 + 用户组 + 回复对象 + 操作项（折行不竖排） -->
    <div class="head">
      {#if linkHref}
        <a class="name" href={linkHref} target="_blank" rel="nofollow ugc noopener" title={node.authorLink ?? ''}>
          {displayName}
        </a>
      {:else}
        <span class="name">{displayName}</span>
      {/if}

      {#if groupLabel}<span class="group">{groupLabel}</span>{/if}
      {#if isReply && replyToName}<span class="reply-to">{t('replyTo', { name: replyToName })}</span>{/if}
      {#if pending}<span class="pending">{t('pending')}</span>{/if}
      {#if edited}
        <span class="edited" title={node.editedAt ? new Date(node.editedAt * 1000).toLocaleString() : ''}>
          {t('edited')}
        </span>
      {/if}

      <span class="ops">
        {#if likeEnabled}
          <button
            type="button"
            class="like"
            class:on={Boolean(node.liked)}
            disabled={likeBusy}
            aria-pressed={Boolean(node.liked)}
            title={node.liked ? t('unlikeTitle') : t('likeTitle')}
            onclick={toggleLike}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M12 20.4S4.6 15.8 4.6 10.7A4.7 4.7 0 0 1 12 7.6a4.7 4.7 0 0 1 7.4 3.1c0 5.1-7.4 9.7-7.4 9.7z"
                fill={node.liked ? 'currentColor' : 'none'}
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linejoin="round"
              />
            </svg>
            <span class="n">{likeCount}</span>
          </button>
        {/if}
        <button type="button" class="op" onclick={() => ctx.replyTo(node.id)}>{t('reply')}</button>
        {#if mine}
          <button type="button" class="op" onclick={() => ctx.startEdit(node)}>{t('edit')}</button>
          <button type="button" class="op danger" onclick={() => ctx.remove(node.id)}>{t('del')}</button>
        {/if}
        {#if likeError}<span class="err">{likeError}</span>{/if}
      </span>
    </div>

    <!-- 第二行：正文 -->
    <div class="content"><Markdown text={node.content} {shortBase} /></div>

    <!-- 第三行：时间 · 位置 · 浏览器 · 系统 -->
    <p class="foot" title={t('metaTitle')}>
      <span class="time">{timeAgo(node.createdAt, lang)}</span>
      {#if info}<span class="sep">·</span><span class="info">{info}</span>{/if}
    </p>

    {#if ctx.replyingId === node.id}
      <div class="form">
        <CommentEditor
          bind:value={ctx.draft}
          lang={lang}
          {shortBase}
          rows={3}
          packs={packs}
          busy={ctx.submitting}
          error={ctx.error}
          submitLabel={t('replySubmit')}
          cancelLabel={t('cancel')}
          autofocus
          placeholder={t('replyPlaceholder', { name: displayName })}
          onsubmit={() => ctx.submitReply(node.id)}
          oncancel={ctx.cancelReply}
          fields={identity}
        />
      </div>
    {/if}

    {#if ctx.editingId === node.id}
      <div class="form">
        <CommentEditor
          bind:value={ctx.editDraft}
          lang={lang}
          {shortBase}
          rows={3}
          packs={packs}
          busy={ctx.editBusy}
          error={ctx.editError}
          submitLabel={t('save')}
          cancelLabel={t('cancel')}
          autofocus
          placeholder={t('editPlaceholder')}
          onsubmit={() => ctx.saveEdit(node.id)}
          oncancel={ctx.cancelEdit}
        />
      </div>
    {/if}
  </div>
</article>

<style>
  .node { display: flex; gap: 0.65rem; align-items: flex-start; }
  .avatar-col { flex-shrink: 0; }
  .avatar-col a { display: block; text-decoration: none; }
  .avatar {
    display: block; width: 36px; height: 36px; border-radius: 50%; object-fit: cover;
    border: 1px solid var(--zc-border, #e2e2e2); background: var(--zc-bg, #fff);
  }
  .fallback {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; border-radius: 50%; font-size: 15px;
    background: var(--zc-border, #ddd); color: var(--zc-fg, #555);
  }
  .main { flex: 1; min-width: 0; }

  /* 第一行：整行 flex-wrap，窄屏折行但每项还是横向排列 */
  .head { display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem 0.5rem; font-size: 0.86rem; }
  .head > * { white-space: nowrap; }
  .name { font-weight: 600; font-size: 0.9rem; color: var(--zc-fg, #333); text-decoration: none; }
  a.name:hover { color: var(--zc-accent, #0070f3); text-decoration: underline; }
  .group { font-size: 0.74rem; color: var(--zc-group, #6d5bd0); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
  .reply-to { font-size: 0.76rem; color: var(--zc-muted, #888); }
  .pending { font-size: 0.76rem; color: var(--zc-warn, #b45309); }
  .edited { font-size: 0.72rem; color: var(--zc-muted, #888); }

  .ops { display: inline-flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; margin-left: 0.2rem; }
  .op {
    background: none; border: none; padding: 0; font: inherit; font-size: 0.78rem;
    color: var(--zc-muted, #888); cursor: pointer;
  }
  .op:hover { color: var(--zc-accent, #0070f3); }
  .op.danger:hover { color: var(--zc-danger, #dc2626); }
  .like {
    display: inline-flex; align-items: center; gap: 0.25rem; font: inherit; font-size: 0.76rem;
    border: 1px solid var(--zc-border, #e2e2e2); background: var(--zc-bg, #fff); color: var(--zc-muted, #888);
    border-radius: 999px; padding: 0.08rem 0.55rem; cursor: pointer;
  }
  .like:hover { color: var(--zc-like, #e0245e); border-color: currentColor; }
  .like.on { color: var(--zc-like, #e0245e); border-color: currentColor; background: var(--zc-like-bg, rgba(224, 36, 94, 0.12)); }
  .like:disabled { opacity: 0.6; cursor: not-allowed; }
  .like .n { min-width: 1.1em; text-align: left; }

  .content { margin: 0.3rem 0 0; color: var(--zc-fg, #333); }
  .foot { margin: 0.25rem 0 0; font-size: 0.74rem; color: var(--zc-muted, #888); display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .foot .sep { color: var(--zc-muted, #888); }
  .form { margin-top: 0.55rem; }
  .err { color: var(--zc-danger, #dc2626); font-size: 0.76rem; }
  .is-pending .content { opacity: 0.85; }
</style>
