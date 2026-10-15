<svelte:options
  customElement={{
    tag: 'zero-subscribe',
    props: {
      apiBase: { attribute: 'api-base', type: 'String' },
      placeholder: { attribute: 'placeholder', type: 'String' },
    },
  }}
/>
<script lang="ts">
  import { apiFetch, resolveBase } from '../lib/api';

  let { apiBase = '', placeholder = '输入邮箱，订阅新文章推送' }: { apiBase?: string; placeholder?: string } = $props();
  const base = $derived(resolveBase(apiBase));

  let email = $state('');
  let busy = $state(false);
  let message = $state('');
  let isError = $state(false);

  async function go() {
    if (!base || busy || !email.trim()) return;
    busy = true;
    isError = false;
    message = '';
    try {
      const d = await apiFetch<{ data: { status: string } }>(base, '/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      message =
        d.data.status === 'confirmed'
          ? '你已订阅成功，无需重复确认。'
          : '订阅请求已收到，请查收邮件并点击确认链接完成订阅。';
      email = '';
    } catch (e) {
      isError = true;
      message = e instanceof Error ? e.message : '订阅失败';
    } finally {
      busy = false;
    }
  }
</script>

<form class="zs" onsubmit={(e) => { e.preventDefault(); void go(); }}>
  <label class="sr-only" for="zs-email">邮箱</label>
  <input id="zs-email" type="email" placeholder={placeholder} bind:value={email} disabled={busy} maxlength="200" />
  <button type="submit" disabled={busy || !email.trim()}>{busy ? '提交中…' : '订阅'}</button>
  {#if message}<p class:err={isError}>{message}</p>{/if}
</form>

<style>
  /* 订阅表单也吃宿主变量，深色下不会出现白底白字 */
  .zs { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; color: var(--text, #333); }
  input {
    flex: 1; min-width: 200px; border: 1px solid var(--border, #e2e2e2); border-radius: 8px;
    padding: 0.5rem 0.7rem; font: inherit; background: var(--card-bg, #fff); color: var(--text, #333);
  }
  input::placeholder { color: var(--text-secondary, #999); }
  button {
    border: none; border-radius: 8px; background: var(--logo-accent-text, #0070f3); color: var(--btn-color, #fff);
    padding: 0.5rem 1.1rem; font: inherit; cursor: pointer;
  }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  p { width: 100%; margin: 0; font-size: 0.85rem; color: #16a34a; }
  p.err { color: #dc2626; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
