<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { EmojiPack } from '../lib/emoji-packs';
  import { tr } from '../lib/i18n';
  import EmojiPicker from './EmojiPicker.svelte';
  import Markdown from './Markdown.svelte';

  /**
   * CommentEditor — 主评论框 / 回复框 / 编辑框共用的那一套
   *
   * 工具条（粗体…短链…引用）、预览开关、表情弹层、插入逻辑都只写在这里一份，
   * CommentSection 与 CommentNode 各自套壳，避免「回复框少了短链按钮」这种事再发生一次。
   */
  let {
    value = $bindable(''),
    placeholder = '',
    shortBase = '/post/',
    lang = '',
    rows = 4,
    busy = false,
    error = '',
    submitLabel = '',
    cancelLabel = '',
    disabled = false,
    autofocus = false,
    packs = [] as EmojiPack[],
    onsubmit,
    oncancel,
    fields,
    trailing,
  }: {
    value?: string;
    placeholder?: string;
    shortBase?: string;
    lang?: string;
    rows?: number;
    busy?: boolean;
    error?: string;
    submitLabel?: string;
    cancelLabel?: string;
    /** 外部条件不满足（比如需要登录）时禁用提交按钮 */
    disabled?: boolean;
    autofocus?: boolean;
    packs?: EmojiPack[];
    onsubmit?: () => void;
    oncancel?: () => void;
    /** 昵称/邮箱/网址这类身份输入，由调用方以片段传进来 */
    fields?: Snippet;
    /** 提交按钮后面的提示文案（登录按钮、审核提示等） */
    trailing?: Snippet;
  } = $props();

  const t = $derived(tr(lang));

  let area = $state<HTMLTextAreaElement | null>(null);
  let previewing = $state(false);
  let emojiOpen = $state(false);

  /* Markdown 工具条：包住选中文本，没选中就插一段示例文字让用户接着改 */
  function wrap(before: string, after: string, ph: string) {
    const el = area;
    if (!el) {
      value += before + ph + after;
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const sel = value.slice(start, end) || ph;
    value = value.slice(0, start) + before + sel + after + value.slice(end);
    previewing = false;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + sel.length);
    });
  }

  /** 表情：插到光标处（有选区就替换掉），插完光标停在这个表情后面 */
  function insertEmoji(text: string) {
    const el = area;
    if (!el) {
      value += text;
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    value = value.slice(0, start) + text + value.slice(end);
    previewing = false;
    emojiOpen = false;
    queueMicrotask(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const canSubmit = $derived(!busy && !disabled && value.trim().length > 0);

  /* 回复框/编辑框是点出来才挂载的，挂上就聚焦，省一次点击 */
  $effect(() => {
    if (autofocus && area) area.focus();
  });

  /** Ctrl/Cmd + Enter 提交，跟多数评论区一致 */
  function onkeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canSubmit) onsubmit?.();
    }
  }
</script>

<div class="editor">
  <div class="tools">
    <button type="button" onclick={() => wrap('**', '**', t('bold'))}>{t('bold')}</button>
    <button type="button" onclick={() => wrap('*', '*', t('italic'))}>{t('italic')}</button>
    <button type="button" onclick={() => wrap('`', '`', t('code'))}>{t('code')}</button>
    <button type="button" onclick={() => wrap('[', '](https://)', t('link'))}>{t('link')}</button>
    <button type="button" onclick={() => wrap('[[', ']]', t('shortlink'))}>{t('shortlink')}</button>
    <button type="button" onclick={() => wrap('\n> ', '', t('quote'))}>{t('quote')}</button>
    <button type="button" class="pv" class:active={previewing} onclick={() => (previewing = !previewing)}>
      {t('preview')}
    </button>
  </div>

  <textarea
    {rows}
    placeholder={placeholder}
    aria-label={t('commentContent')}
    bind:value
    bind:this={area}
    onkeydown={onkeydown}
    disabled={busy}
    class:has-error={Boolean(error)}
    autocapitalize="sentences"
    autocomplete="on"
  ></textarea>

  {#if previewing}
    <div class="preview">
      {#if value.trim()}
        <Markdown text={value} {shortBase} />
      {:else}
        <p class="hint">{t('previewEmpty')}</p>
      {/if}
    </div>
  {/if}

  {#if fields}{@render fields()}{/if}
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}

  <div class="actions">
    {#if packs.length}
      <div class="emoji-wrap">
        <button
          type="button"
          class="emoji-btn"
          class:active={emojiOpen}
          aria-expanded={emojiOpen}
          aria-haspopup="dialog"
          onclick={() => (emojiOpen = !emojiOpen)}
        >
          {t('emoji')}
        </button>
        {#if emojiOpen}
          <EmojiPicker {packs} {lang} onpick={insertEmoji} onclose={() => (emojiOpen = false)} />
        {/if}
      </div>
    {/if}

    <button type="button" class="primary" disabled={!canSubmit} onclick={() => onsubmit?.()}>
      {busy ? t('submitting') : submitLabel}
    </button>
    {#if oncancel}
      <button type="button" class="ghost" onclick={oncancel}>{cancelLabel || t('cancel')}</button>
    {/if}
    {#if trailing}{@render trailing()}{/if}
  </div>
</div>

<style>
  .editor { display: block; }
  textarea {
    width: 100%; box-sizing: border-box; border: 1px solid var(--zc-border, #ddd);
    border-radius: 8px; padding: 0.6rem; font: inherit; resize: vertical;
    background: var(--zc-bg, #fff); color: var(--zc-fg, #333);
  }
  textarea::placeholder { color: var(--zc-muted, #999); }
  textarea.has-error { border-color: var(--zc-danger, #dc2626); }
  .tools { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.4rem; }
  .tools button {
    font-size: 0.78rem; padding: 0.15rem 0.55rem; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--zc-border, #e2e2e2); background: var(--zc-bg, #fff); color: var(--zc-muted, #888);
  }
  .tools button:hover { color: var(--zc-fg, #333); border-color: var(--zc-accent, #0070f3); }
  .tools button.pv { margin-left: auto; }
  .tools button.pv.active { color: var(--zc-on-accent, #fff); background: var(--zc-accent, #0070f3); border-color: var(--zc-accent, #0070f3); }
  .preview {
    margin-top: 0.5rem; padding: 0.6rem; border: 1px dashed var(--zc-border, #ddd);
    border-radius: 8px; background: var(--zc-code-bg, #fafafa); color: var(--zc-fg, #333);
  }
  .hint { color: var(--zc-muted, #888); font-size: 0.85rem; margin: 0; }
  .actions { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.55rem; flex-wrap: wrap; }
  .emoji-wrap { position: relative; }
  .emoji-btn {
    font-size: 0.85rem; padding: 0.32rem 0.7rem; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--zc-border, #e2e2e2); background: var(--zc-bg, #fff); color: var(--zc-muted, #888);
  }
  .emoji-btn:hover { color: var(--zc-fg, #333); border-color: var(--zc-accent, #0070f3); }
  .emoji-btn.active { color: var(--zc-on-accent, #fff); background: var(--zc-accent, #0070f3); border-color: var(--zc-accent, #0070f3); }
  button { font: inherit; border-radius: 8px; border: 1px solid var(--zc-border, #ddd); background: var(--zc-bg, #fff); color: var(--zc-fg, #333); padding: 0.35rem 0.9rem; cursor: pointer; }
  button.primary { background: var(--zc-accent, #0070f3); border-color: var(--zc-accent, #0070f3); color: var(--zc-on-accent, #fff); }
  button.ghost { color: var(--zc-muted, #888); }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  .error-text { color: var(--zc-danger, #dc2626); font-size: 0.85rem; margin: 0.3rem 0 0; }
</style>
