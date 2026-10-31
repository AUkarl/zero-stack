<script lang="ts">
  import { flash } from '#lib/toast.svelte';
  import { get, put } from '#lib/api';
  import { buildNote } from './types';

  /**
   * 主题配置文件：直接读写仓库里的 params.toml / config.toml / menus.zh.toml 与友链数据文件。
   *
   * 这里不解析也不重排文本，编辑器里是什么就提交什么（注释与空行因此能原样保留）。
   * 下拉的初值只是「后端一定认」的三份配置文件；友链那份的真实位置来自
   * GET /api/admin/repo/files —— 数据目录挪过、或设置里改了友链文件时，列出的路径
   * 必须和后端放开的完全一致，否则就是「下拉里点得动、一保存被拒」。
   */
  let files = $state<{ path: string; label: string }[]>([
    { path: 'config/_default/params.toml', label: 'config/_default/params.toml（站点覆盖项）' },
    { path: 'config/_default/config.toml', label: 'config/_default/config.toml（Hugo 基础配置）' },
    { path: 'config/_default/menus.zh.toml', label: 'config/_default/menus.zh.toml（导航菜单）' },
  ]);

  interface RepoFile {
    exists: boolean;
    path: string;
    content: string;
    sha: string;
    bytes?: number;
  }
  interface WriteResult {
    path: string;
    sha: string;
    bytes: number;
    build?: { triggered?: boolean; error?: string } | null;
  }

  let path = $state<string>('config/_default/params.toml');
  let content = $state('');
  let baseline = $state('');
  let sha = $state('');
  let loaded = $state(false);
  let exists = $state(true);
  let bytes = $state(0);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');
  /* 顶部那行结果提示改走右上角浮层（页面一长就看不见那行小字） */
  flash('err', () => error);
  flash('ok', () => notice);
  let note = $state<string | null>(null);
  /** 保存后固定为 true，配合「重新读取」按钮给出下一步动作 */
  let conflict = $state(false);
  let triggerBuild = $state(true);

  const dirty = $derived(loaded && content !== baseline);

  const errText = (e: unknown): string => {
    const m = e instanceof Error ? e.message : '请求失败';
    return m === 'AUTH_EXPIRED' ? '登录已过期，请重新登录后台' : m;
  };

  /**
   * #lib/api 只把 message 抛出来、不带状态码，而后端 409 的文案是固定的，
   * 所以只能按文案识别冲突（拿不到状态码时的兜底格式是「请求失败 (409)」）。
   */
  function isConflict(m: string): boolean {
    return m.includes('409') || m.includes('已被改动') || m.includes('重新读取后再保存');
  }

  async function readFile(target: string) {
    loading = true;
    error = '';
    notice = '';
    note = null;
    conflict = false;
    try {
      const d = await get<{ data: RepoFile }>(`/api/admin/repo/file?path=${encodeURIComponent(target)}`);
      const f = d.data;
      path = f.path || target;
      content = f.content ?? '';
      baseline = content;
      sha = f.sha ?? '';
      exists = f.exists !== false;
      bytes = f.bytes ?? content.length;
      loaded = true;
      if (!exists) {
        // 站点没有这份文件时，把主题自带的全量注释模板读进来当起点：
        // 直接面对一个空编辑器没人知道从哪下手，而「读取不到」也常被当成坏了
        const theme = target.replace(/^config\//, 'themes/zero/config/');
        if (theme !== target) {
          try {
            const t = await get<{ data: RepoFile }>(`/api/admin/repo/file?path=${encodeURIComponent(theme)}`);
            if (t.data?.exists && t.data.content) {
              content = t.data.content;
              baseline = content;
              sha = '';
              error = `仓库里还没有 ${target}，下面载入的是主题默认清单（${theme}）：改成你要的再保存，就会在你的站点里建出这份文件。`;
              return;
            }
          } catch {
            // 主题那份也读不到（子模块还没拉下来等）：就按空白处理，走下面的提示
          }
        }
        error = `仓库里还没有 ${path}，编辑器里是空白；保存会新建这份文件，主题读不到它时才会回落到默认值。`;
      }
    } catch (e) {
      const m = errText(e);
      error = `读取 ${target} 失败：${m}`;
      content = '';
      baseline = '';
      sha = '';
      loaded = false;
    } finally {
      loading = false;
    }
  }

  async function switchFile(next: string, sel?: HTMLSelectElement) {
    if (next === path) return;
    if (dirty && !confirm(`切换文件会丢掉 ${path} 里未保存的改动（没点「保存」的内容不会写进仓库）。仍要切到 ${next} 吗？`)) {
      // 单向绑定的 select 不会因为状态没变而回滚，手动把下拉拨回去
      if (sel) sel.value = path;
      return;
    }
    // 先清掉上一份的 sha，避免手滑把 A 文件的 sha 当成 B 文件的用
    loaded = false;
    content = '';
    baseline = '';
    sha = '';
    error = '';
    notice = '';
    note = null;
    conflict = false;
    path = next;
    await readFile(next);
  }

  async function save() {
    error = '';
    notice = '';
    note = null;
    conflict = false;
    if (!loaded) {
      error = '还没读到文件内容，先点「读取」。空内容提交会把文件清空。';
      return;
    }
    if (
      !confirm(
        `把编辑器里的内容整份覆盖写入 ${path}？\n\n这会生成一次仓库提交，注释和空白都按你现在看到的样子保存${
          triggerBuild ? '，并请求站点重新构建' : ''
        }。${loaded && exists && content.trim() === '' ? '\n\n注意：编辑器里是空的，保存会把这份已有文件清空。' : ''}`,
      )
    ) {
      return;
    }
    saving = true;
    try {
      const d = await put<{ data: WriteResult }>('/api/admin/repo/file', {
        path,
        content,
        // 乐观锁：带上读取时的 sha，后端比对不上就回 409
        sha: sha || undefined,
        triggerBuild,
      });
      const r = d.data;
      let build: string | null = null;
      if (r.build?.triggered) build = '已请求 Cloudflare Pages 重新构建，前台几分钟内更新。';
      else if (r.build && r.build.triggered === false) build = buildNote(r.build.error);
      else if (triggerBuild) build = '后端没有返回构建结果，按未触发处理；前台没更新就手动重建一次。';
      // 回读而不是直接用 PUT 返回的 sha：本地仓库后端提交后回的是 local:<时间戳> 这类临时值，
      // 只有再读一次拿到的才是下次乐观锁能比对上的 sha
      await readFile(path);
      // 绿字只说「写进去了」这一件事，构建到底有没有点起来归下面那行灰字，两者不重复也不打架
      notice = `已写入仓库 ${r.path}（${r.bytes} 字节）`;
      note = build;
    } catch (e) {
      const m = errText(e);
      error = m;
      if (isConflict(m)) {
        conflict = true;
        error = `${m}（已被他人改动，请重新读取）`;
      }
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    // 先问后端「到底哪几份能改」，再读默认那一份；这个面板只用一次，顺序无所谓
    void (async () => {
      try {
        const d = await get<{ data: { path: string; label: string }[] }>('/api/admin/repo/files');
        if (d.data?.length) files = d.data;
      } catch {
        // 拿不到就用上面那三项兜底，友链那份不列出来就是了
      }
      await readFile(files[0].path);
    })();
  });
</script>

<div class="wrap">
  <p class="muted small intro">
    这里改的是<em>仓库里的源配置文件</em>，不是「设置」页的运行时开关：整份文本原样写回 Git，注释、空行、顺序都不会被重排。
    前台主题的取值优先级是 <code>data/*.json</code>（上面几个子标签保存的覆盖文件）&gt; 站点的
    <code>config/_default/params.toml</code> &gt; 主题的 <code>config/_default/params.toml</code>（全部默认值与逐项注释）。
    站点那份只写与默认值不同的那几项就行，要改别的项从主题那份里把键名抄过来；
    在「前端管理」里配过的项，改 params 也不会生效，要先删掉对应的覆盖文件。
  </p>

  <div class="card box">
    <div class="row controls">
      <label class="pick">
        配置文件
        <select
          value={path}
          disabled={loading || saving}
          onchange={(e) => void switchFile(e.currentTarget.value, e.currentTarget)}
        >
          {#each files as f (f.path)}<option value={f.path}>{f.label}</option>{/each}
        </select>
      </label>
      <button class="sm" onclick={() => void readFile(path)} disabled={loading || saving}>
        {loading ? '读取中…' : '读取'}
      </button>
      <button class="primary sm" onclick={() => void save()} disabled={saving || loading || !loaded}>
        {saving ? '保存中…' : '保存到仓库'}
      </button>
      <label class="switch">
        <input type="checkbox" bind:checked={triggerBuild} disabled={saving} />
        <span>保存后触发站点构建</span>
      </label>
    </div>

    <div class="row meta">
      {#if loaded}
        <span class="badge good">已读取</span>
        <span class="muted small"><code>{path}</code></span>
        <span class="muted small">{bytes} 字符</span>
        {#if sha}<span class="muted small" title={sha}>sha {sha.slice(0, 12)}</span>{/if}
        {#if dirty}<span class="badge pending">有未保存改动</span>{/if}
      {:else}
        <span class="badge bad">未读取</span>
        <span class="muted small">点「读取」把仓库里的内容拿进来；未读取时不能保存。</span>
      {/if}
    </div>

    {#if note}<p class="muted small">{note}</p>{/if}
    {#if conflict}
      <p class="err small">
        保存被拦下：这份文件在你编辑期间被改动过，你手上的 sha 已经过期。点「读取」拿到最新内容，把改动重新贴上去再保存，别直接覆盖。
      </p>
    {/if}

    <textarea
      class="mono"
      rows="24"
      spellcheck="false"
      placeholder="选好文件后点「读取」，仓库里的完整文本会出现在这里"
      bind:value={content}
      disabled={!loaded}
    ></textarea>

    <p class="muted small tips">
      改错了就用「读取」把仓库内容拉回来（未保存的改动会丢）；想回到上一个版本请看仓库的提交历史。
      TOML 里字符串要带引号、布尔用 true/false，YAML 靠缩进分层级，改完建议先读一遍再保存。
    </p>
  </div>
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .intro {
    margin: 0;
    line-height: 1.75;
  }
  .intro code {
    background: var(--panel-2);
    border-radius: 4px;
    padding: 0 0.22rem;
  }
  .box {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .controls {
    gap: 0.5rem;
  }
  .pick {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.84rem;
  }
  .pick select {
    min-width: min(300px, 100%);
    padding: 0.2rem 0.4rem;
    font-size: 0.82rem;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--fg);
  }
  .meta {
    gap: 0.5rem;
  }
  .meta code {
    background: var(--panel-2);
    border-radius: 4px;
    padding: 0 0.25rem;
  }
  .mono {
    font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
    font-size: 0.84rem;
    line-height: 1.6;
    tab-size: 2;
    white-space: pre;
    overflow-wrap: normal;
    resize: vertical;
  }
  .small {
    font-size: 0.76rem;
  }
  .tips {
    margin: 0;
    line-height: 1.7;
  }
</style>
