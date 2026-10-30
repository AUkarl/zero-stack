<script lang="ts">
  import { renderMarkdown, countWords } from './markdown';

  let {
    value = $bindable(''),
    rows = 14,
    placeholder = '',
    shortBase = '/post/',
    plainLinks = false,
    disabled = false,
  }: {
    value?: string;
    rows?: number;
    placeholder?: string;
    shortBase?: string;
    /**
     * 文章 / 投稿的正文由 Hugo 渲染，认不了 [[…]] —— 那套短链只在评论、时刻、群发（评论包渲染）里成立。
     * 给真正按文章发布的编辑器打开这个开关：按钮改插普通 Markdown 链接，提示也换口径。
     */
    plainLinks?: boolean;
    disabled?: boolean;
  } = $props();

  let area = $state<HTMLTextAreaElement | null>(null);
  let previewing = $state(false);

  const html = $derived(renderMarkdown(value, { shortBase }));
  const words = $derived(countWords(value));

  /** 包住选区（没选中就插占位词），并把光标停在插入的内容上 */
  function wrap(before: string, after: string, placeholderText: string) {
    const el = area;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const sel = value.slice(start, end) || placeholderText;
    value = value.slice(0, start) + before + sel + after + value.slice(end);
    previewing = false;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + sel.length);
    });
  }

  /** 在行首加前缀（标题、引用、列表） */
  function prefix(prefixText: string, placeholderText: string) {
    const el = area;
    if (!el) return;
    const start = el.selectionStart;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', start);
    const at = lineEnd === -1 ? value.length : lineEnd;
    const line = value.slice(lineStart, at);
    const next = line ? `${prefixText}${line.replace(/^[#>\-*]\s*/, '')}` : `${prefixText}${placeholderText}`;
    value = value.slice(0, lineStart) + next + value.slice(at);
    previewing = false;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(lineStart + next.length, lineStart + next.length);
    });
  }

  function insert(text: string) {
    const el = area;
    if (!el) {
      value += text;
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    value = value.slice(0, start) + text + value.slice(end);
    previewing = false;
    queueMicrotask(() => {
      el.focus();
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
    });
  }

  /** Tab 缩进而不是跳焦点 */
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab' || disabled) return;
    e.preventDefault();
    insert('  ');
  }
</script>

<div class="me">
  <div class="tools">
    <button type="button" class="sm" disabled={disabled} onclick={() => wrap('**', '**', '加粗')}>粗体</button>
    <button type="button" class="sm" disabled={disabled} onclick={() => wrap('_', '_', '斜体')}>斜体</button>
    <button type="button" class="sm" disabled={disabled} onclick={() => wrap('`', '`', '代码')}>行内代码</button>
    <button type="button" class="sm" disabled={disabled} onclick={() => wrap('```\n', '\n```', '代码块')}>代码块</button>
    <button type="button" class="sm" disabled={disabled} onclick={() => wrap('[', '](https://)', '链接文字')}>链接</button>
    {#if plainLinks}
      <button type="button" class="sm" disabled={disabled} onclick={() => wrap('[', '](/posts/文章标识符/)', '显示文字')}>站内文章链接</button>
    {:else}
      <button type="button" class="sm" disabled={disabled} onclick={() => insert('[[文章标识符|显示文字]]')}>站内短链</button>
    {/if}
    <button type="button" class="sm" disabled={disabled} onclick={() => prefix('## ', '小标题')}>标题</button>
    <button type="button" class="sm" disabled={disabled} onclick={() => prefix('> ', '引用')}>引用</button>
    <button type="button" class="sm" disabled={disabled} onclick={() => prefix('- ', '列表项')}>列表</button>
    <span class="grow"></span>
    <span class="muted small">{words} 字</span>
    <button type="button" class="sm" class:on={previewing} onclick={() => (previewing = !previewing)}>
      {previewing ? '返回编辑' : '预览'}
    </button>
  </div>

  {#if previewing}
    <div class="preview"><h4>正文预览</h4>{@html html}</div>
  {:else}
    <textarea
      id="bodyEditor"
      rows={rows}
      placeholder={placeholder}
      bind:value
      {disabled}
      onkeydown={onKeydown}
      bind:this={area}
    ></textarea>
  {/if}
  <p class="muted small tip">
    {#if plainLinks}
      支持标题 / 列表 / 引用 / 代码 / 表格；站内文章用普通链接写
      <code>[显示文字](/posts/文章标识符/)</code>，标识符就是文件名去扩展名。
      <code>[[…]]</code> 那种短链只在评论、时刻和群发里认，文章正文里会原样显示。
    {:else}
      支持标题 / 列表 / 引用 / 代码 / 表格；站内短链写 <code>[[文章标识符]]</code> 或
      <code>[[文章标识符|显示文字]]</code>，渲染成 <code>{shortBase}文章标识符/</code>。
    {/if}
  </p>
</div>

<style>
  .me {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.32rem;
  }
  .tools .grow {
    flex: 1;
  }
  .tools .on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .small {
    font-size: 0.76rem;
  }
  textarea {
    width: 100%;
    font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
    font-size: 0.86rem;
    line-height: 1.65;
    min-height: 320px;
    resize: vertical;
  }
  .tip {
    margin: 0;
  }
  .preview {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    padding: 0.6rem 1rem 1rem;
    min-height: 220px;
    overflow: auto;
  }
  .preview h4 {
    margin: 0.4rem 0;
    font-size: 0.82rem;
    color: var(--muted);
    font-weight: 500;
  }
  .preview :global(p) {
    line-height: 1.8;
  }
  .preview :global(pre) {
    background: #f3f4f6;
    border-radius: 8px;
    padding: 0.7rem 0.8rem;
    overflow: auto;
    font-size: 0.83rem;
  }
  .preview :global(code) {
    background: #f3f4f6;
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
    font-size: 0.86em;
  }
  .preview :global(blockquote) {
    margin: 0.6rem 0;
    padding: 0.2rem 0.9rem;
    border-left: 3px solid var(--accent);
    background: var(--accent-soft);
  }
  .preview :global(table) {
    display: block;
    overflow: auto;
  }
  .preview :global(img) {
    max-width: 100%;
  }
</style>
