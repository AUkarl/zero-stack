<script lang="ts">
  import { fmtDate, get } from '#lib/api';

  interface Row {
    id: string;
    actorName: string | null;
    action: string;
    target: string | null;
    detail: unknown;
    ip: string | null;
    createdAt: number;
  }

  const PAGE = 100;

  /** 后端 action 的中文名；老流水里可能出现这里没列的键，原样显示，绝不藏记录 */
  const LABEL: Record<string, string> = {
    config: '站点设置',
    params: '仓库配置文件',
    email: '测试发信',
    comment: '评论审核',
    content: '文章',
    moment: '时刻',
    media: '媒体',
    backup: '备份与恢复',
    translate: '翻译',
    user: '用户',
    profile: '账号资料',
    draft: '投稿审核',
    authorRequest: '作者认证',
    invite: '邀请码',
    friend: '友链',
    friendApp: '友链申请',
    broadcast: '邮件群发',
  };

  const ORDER = Object.keys(LABEL);

  let rows = $state<Row[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let action = $state('');
  let loading = $state(false);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      const d = await get<{
        data: { rows: Row[]; total: number; limit: number; offset: number };
      }>(`/api/admin/audit?limit=${PAGE}&offset=${offset}${action ? `&action=${action}` : ''}`);
      rows = d.data.rows ?? [];
      total = d.data.total ?? 0;
    } catch (e) {
      error = e instanceof Error ? e.message : '读取操作流水失败';
      rows = [];
      total = 0;
    } finally {
      loading = false;
    }
  }

  function pick(next: string) {
    action = next;
    offset = 0;
    void load();
  }

  function page(delta: number) {
    offset = Math.max(0, Math.min(Math.max(0, total - PAGE), offset + delta));
    void load();
  }

  /** 详情只留一行给人扫，展开才是原文：一条 params 写盘的 detail 能有几 KB */
  function brief(detail: unknown): string {
    if (detail === null || detail === undefined) return '';
    const d = detail as Record<string, unknown>;
    if (d.event === 'patch') {
      const changed = (d.changed as { key: string }[]) ?? [];
      const failed = (d.failed as { key: string }[]) ?? [];
      return `改 ${changed.length} 项${failed.length ? ` · 失败 ${failed.length} 项` : ''}${changed.length ? `：${changed.slice(0, 6).map((c) => c.key).join('、')}${changed.length > 6 ? ' …' : ''}` : ''}`;
    }
    if (d.event === 'put' || d.event === 'batch' || d.event === 'repo-file.write') {
      const p = typeof d.path === 'string' ? `${d.path} ` : '';
      return `${p}${d.bytes !== undefined ? `${d.bytes} 字节` : ''}${d.total !== undefined ? ` 共 ${d.total} 篇 · 成功 ${d.done}` : ''}`.trim();
    }
    return JSON.stringify(detail).slice(0, 160);
  }

  $effect(() => void load());
</script>

<div class="row spread head">
  <h2>操作流水</h2>
  <div class="row">
    <span class="muted small">{loading ? '读取中…' : `共 ${total} 条，这页 ${rows.length} 条`}</span>
    <button class="sm" onclick={() => void load()} disabled={loading}>重新读取</button>
  </div>
</div>

<p class="muted small">
  后台每一次写操作都留一笔：谁、什么时候、动了哪一类、对象是什么。设置类还记了改前改后的值（密钥只记「有没有值」，原文绝不落这张表）。
  这张表不进备份，也不自动清理，站跑久了会一直长。
</p>

{#if error}<p class="err">{error}</p>{/if}

<div class="tabs">
  <button class="sm {action === '' ? 'primary' : ''}" onclick={() => pick('')}>全部</button>
  {#each ORDER as k}
    <button class="sm {action === k ? 'primary' : ''}" onclick={() => pick(k)}>{LABEL[k]}</button>
  {/each}
</div>

<div class="card table-wrap">
  <table class="cols-wide">
    <thead>
      <tr>
        <th>时间</th>
        <th>谁</th>
        <th>门类</th>
        <th>对象</th>
        <th>摘要</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.id)}
        <tr>
          <td class="small muted">{fmtDate(r.createdAt)}</td>
          <td class="small">{r.actorName || '—'}</td>
          <td class="small"><span class="badge">{LABEL[r.action] ?? r.action}</span></td>
          <td class="small mono">{r.target || '—'}</td>
          <td class="small">{brief(r.detail)}</td>
          <td>
            {#if r.detail}<details>
              <summary class="muted small">原文</summary>
              <pre class="small wrap">{JSON.stringify(r.detail, null, 2)}</pre>
            </details>{/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="6" class="muted">{loading ? '加载中…' : '这个门类还没有流水。'}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<div class="row">
  <button class="sm" onclick={() => page(-PAGE)} disabled={offset === 0}>上一页</button>
  <span class="muted small">第 {Math.floor(offset / PAGE) + 1} 页 / 共 {Math.max(1, Math.ceil(total / PAGE))} 页</span>
  <button class="sm" onclick={() => page(PAGE)} disabled={offset + PAGE >= total}>下一页</button>
</div>

<style>
  .head {
    margin-bottom: 0.6rem;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin: 0.7rem 0;
  }
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    word-break: break-all;
  }
  pre.wrap {
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }
</style>
