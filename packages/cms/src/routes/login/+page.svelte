<script lang="ts">
  import { goto } from '$app/navigation';
  import { getApiBase, setApiBase, post, type ApiError } from '#lib/api';
  import { session } from '#lib/session.svelte';

  let api = $state(getApiBase());
  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  /** 第二因子：只有后端明确要的时候才出现对应输入框（与前台账号页同一套规则） */
  let need = $state<'' | 'totp' | 'email-code'>('');
  let totp = $state('');
  let code = $state('');
  let codeSent = $state(false);

  async function login() {
    if (busy) return;
    busy = true;
    error = '';
    setApiBase(api);
    const body: Record<string, string> = { email, password };
    if (need === 'totp') body.totp = totp.replace(/\s/g, '');
    if (need === 'email-code') body.code = code.replace(/\s/g, '');
    try {
      const d = await post<{ data: { user: any } }>('/api/auth/login', body);
      if (d.data.user.role !== 'admin') throw new Error('该账号不是管理员，无法进入后台');
      session.user = d.data.user;
      session.checked = true;
      goto('/');
    } catch (e) {
      error = e instanceof Error ? e.message : '登录失败';
      const next = (e as ApiError).body?.next;
      need = next === 'totp' || next === 'email-code' ? next : '';
      if (need !== 'email-code') codeSent = false;
    } finally {
      busy = false;
    }
  }

  async function sendCode() {
    if (busy) return;
    if (!email) {
      error = '先填管理员邮箱';
      return;
    }
    busy = true;
    error = '';
    try {
      await post('/api/auth/send-code', { email, scene: 'login' });
      codeSent = true;
    } catch (e) {
      error = e instanceof Error ? e.message : '验证码发送失败';
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={(e) => { e.preventDefault(); void login(); }}>
    <h2>Zero 管理后台</h2>
    <p class="muted sub">登录后管理文章、评论、时刻、友链与站点配置</p>

    <label>
      <span>API 地址（留空表示同源，本地开发用）</span>
      <input placeholder="https://zero-api.xxx.workers.dev" bind:value={api} autocomplete="off" />
    </label>
    <label>
      <span>管理员邮箱</span>
      <input type="email" bind:value={email} required autocomplete="username" />
    </label>
    <label>
      <span>密码</span>
      <input type="password" bind:value={password} required autocomplete="current-password" />
    </label>

    {#if need === 'totp'}
      <label>
        <span>身份验证器动态码（6 位）</span>
        <input inputmode="numeric" maxlength="8" placeholder="000000" bind:value={totp} autocomplete="one-time-code" />
      </label>
      <p class="muted tip">账号开启了两步验证：密码通过后还要交验证器上当前的 6 位码。</p>
    {:else if need === 'email-code'}
      <label>
        <span>邮箱验证码（6 位）</span>
        <input inputmode="numeric" maxlength="8" placeholder="000000" bind:value={code} autocomplete="one-time-code" />
      </label>
      <p class="muted tip">
        {#if codeSent}验证码已发到 {email}，10 分钟内有效。{:else}当前登录策略要邮箱验证码，点下面按钮发一封。{/if}
      </p>
      <button class="ghost" type="button" disabled={busy} onclick={sendCode}>{codeSent ? '重新发送' : '发送验证码'}</button>
    {/if}

    {#if error}<p class="err">{error}</p>{/if}
    <button class="primary go" type="submit" disabled={busy || !email || !password}>
      {busy ? '登录中…' : '登 录'}
    </button>
    <p class="muted tip">首次部署时，通过 /api/auth/register 注册的首个账号即为管理员。</p>
  </form>
</div>

<style>
  .wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  form {
    width: 380px;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    padding: 1.8rem;
  }
  .sub {
    margin: -0.4rem 0 0.4rem;
    font-size: 0.85rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  label span {
    font-size: 0.82rem;
    color: var(--muted);
  }
  .go {
    margin-top: 0.2rem;
    padding: 0.6rem;
  }
  .tip {
    font-size: 0.78rem;
    margin: 0;
  }
</style>
