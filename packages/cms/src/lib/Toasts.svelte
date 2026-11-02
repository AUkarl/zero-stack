<script lang="ts">
  import { toast } from '#lib/toast.svelte';

  /**
   * 右上角的操作结果浮层。全站只挂在 +layout 里一份，
   * 各页通过 flash()/toast.push() 投递，不自己画横幅。
   */
  const icon: Record<string, string> = { ok: '✓', warn: '!', err: '✕' };
</script>

<div class="toasts" role="region" aria-label="操作结果" aria-live="polite">
  {#each toast.list as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'err' ? 'alert' : 'status'}>
      <span class="ic" aria-hidden="true">{icon[t.kind] ?? '•'}</span>
      <p>{t.text}</p>
      <button type="button" class="x" aria-label="关闭提示" onclick={() => toast.dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: 0.9rem;
    right: 0.9rem;
    z-index: 120;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(24rem, calc(100vw - 1.8rem));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: 1.4rem minmax(0, 1fr) 1.4rem;
    align-items: start;
    gap: 0.45rem;
    padding: 0.62rem 0.7rem;
    border: 1px solid var(--border);
    border-left-width: 4px;
    border-radius: var(--radius);
    background: var(--panel);
    color: var(--fg);
    box-shadow: var(--shadow);
    font-size: 0.86rem;
    line-height: 1.45;
  }
  .toast p {
    margin: 0;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .toast .ic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
    font-weight: 700;
    font-size: 0.82rem;
  }
  .toast.ok {
    border-left-color: var(--good);
  }
  .toast.ok .ic {
    background: var(--good-soft);
    color: var(--good);
  }
  .toast.warn {
    border-left-color: var(--warn);
  }
  .toast.warn .ic {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .toast.err {
    border-left-color: var(--bad);
  }
  .toast.err .ic {
    background: var(--bad-soft);
    color: var(--bad);
  }
  .toast .x {
    min-height: 1.4rem;
    width: 1.4rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 1.05rem;
    line-height: 1;
    cursor: pointer;
  }
  .toast .x:hover {
    color: var(--fg);
  }
</style>
