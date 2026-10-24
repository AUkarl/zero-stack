/**
 * GitHub Contents API 适配：zero-cms 发布的文章最终落进站点仓库，
 * Hugo 仍由 GitHub 触发构建，保持"内容进 Git"这条主线。
 */

export interface CommitInput {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;
  branch: string;
  token: string;
}

export interface CommitResult {
  success: boolean;
  sha?: string;
  path?: string;
  committedAt?: string;
  error?: string;
  /** 内容与仓库里现有的一致，没有产生提交 */
  unchanged?: boolean;
}

const API = 'https://api.github.com';

/**
 * GitHub 的 contents 接口回的是 base64 **字节**串，而 `atob` 给回来的是「一个字节一个字符」的
 * Latin-1 文本：中文文件这样读出来就是乱码，编辑器里再保存一次等于把乱码按 UTF-8 又编一遍写回仓库，
 * 每存一次多叠一层。所以读侧统一过 TextDecoder，与写侧（TextEncoder → btoa）配成一对。
 */
function fromBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function headers(token: string, accept: string): Record<string, string> {
  return {
    /* GitHub 的 REST API 硬性要求 User-Agent，缺了直接 403 Forbidden —— 与令牌权限无关，
       而 Cloudflare Workers 的 fetch 默认不发 User-Agent，所以必须自己带上。 */
    'User-Agent': 'zero-cms (cloudflare-workers)',
    // 用 wrangler secret put 粘贴时很容易带上尾部的 \r\n，带着它 GitHub 会当成非法凭据
    Authorization: `Bearer ${token.trim()}`,
    Accept: accept,
    'X-GitHub-Request-Type': 'zero-cms',
    'Content-Type': 'application/json',
  };
}

/** 出错时把「到底打到哪个仓库、哪条分支、哪个文件」一起说清楚：
    403 / 404 十有八九是 owner、repo 或分支在后台填错了，光看 GitHub 的原文猜不出来。 */
async function readError(res: Response, target: { owner: string; repo: string; branch: string; path?: string }): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string; errors?: { message: string }[] };
    detail = body.message ?? '';
    if (body.errors?.length) detail += `（${body.errors.map((e) => e.message).join('; ')}）`;
  } catch {
    detail = res.statusText;
  }
  const where = `（目标：${target.owner}/${target.repo}@${target.branch}${target.path ? `:${target.path}` : ''}）`;
  if (res.status === 401) return `GitHub 令牌无效或已过期，请重新生成并更新 GITHUB_TOKEN 密钥${where}`;
  if (res.status === 403) {
    // GitHub 对「认证通过但没这个仓库的权限」统一回 403 Forbidden（不回 404，避免泄露仓库是否存在），
    // 绝大多数情况是 fine-grained PAT 没把目标仓库勾进 Selected repositories，或没给 Contents: Read and write。
    return (
      `GitHub 拒绝访问（403）：${detail || 'Forbidden'}。` +
      '逐项确认：① 令牌的账号就是 githubOwner 本人；② Fine-grained PAT 要在 Selected repository 里显式加上这个仓库，' +
      '且 Permissions → Contents = Read and write（Only select repositories 里没列到的仓库就是 403）；' +
      `③ Classic PAT 要有 repo 作用域（私密仓库没有 repo 就是 403）；④ 账号若开了 IP allow list 或 SAML SSO，还要给这个令牌/IP 授权${where}`
    );
  }
  if (res.status === 404) return `仓库或路径不存在：${detail}${where}`;
  return `GitHub ${res.status}：${detail}${where}`;
}

/** 取当前文件内容与 sha，Hugo 的 md 是 UTF-8 文本，直接按 content 接口读 */
export async function readFile(input: Omit<CommitInput, 'content' | 'message'>): Promise<{ content: string; sha: string } | null> {
  const url = `${API}/repos/${input.owner}/${input.repo}/contents/${encodeURIComponentPath(input.path)}?ref=${encodeURIComponent(input.branch)}`;
  const res = await fetch(url, { headers: headers(input.token, 'application/vnd.github+json') });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res, input));

  const body = (await res.json()) as { content?: string; encoding?: string; sha: string };
  const text = body.content ? fromBase64Utf8(body.content) : '';
  return { content: text, sha: body.sha };
}

export async function writeFile(input: CommitInput): Promise<CommitResult> {
  const path = encodeURIComponentPath(input.path);
  const url = `${API}/repos/${input.owner}/${input.repo}/contents/${path}`;

  // 更新必须带上一版 sha，否则 GitHub 会拒绝并提示冲突
  let sha: string | undefined;
  let current: string | undefined;
  const probe = await fetch(`${url}?ref=${encodeURIComponent(input.branch)}`, {
    headers: headers(input.token, 'application/vnd.github+json'),
  });
  if (probe.ok) {
    const body = (await probe.json()) as { sha: string; content?: string };
    sha = body.sha;
    // 这次反正已经把文件读出来了，顺手比一下内容：一样的话就不提交。
    // 定时任务天天导出同一份统计，省掉空提交也就省掉一次 Pages 构建。
    if (body.content) current = fromBase64Utf8(body.content);
  } else if (probe.status !== 404) return { success: false, error: await readError(probe, input) };

  if (current !== undefined && current === input.content) {
    return { success: true, sha, path: input.path, unchanged: true };
  }

  const bytes = new TextEncoder().encode(input.content);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);

  const res = await fetch(url, {
    method: 'PUT',
    headers: headers(input.token, 'application/vnd.github+json'),
    body: JSON.stringify({
      message: input.message,
      content: btoa(binary),
      branch: input.branch,
      sha,
    }),
  });

  if (!res.ok) return { success: false, error: await readError(res, input) };
  const body = (await res.json()) as { commit: { sha: string }; content: { path: string; sha: string } };
  /* 回 content.sha（这一版内容的 blob 号），不是 commit.sha：读文件与乐观锁比对的都是 blob 号
     （见 readFile 与 admin.ts 的冲突判定）。把提交号当成「这篇的新版本号」回给后台，后台带着它
     再保存一次，与读到的 blob 号永远不等 —— 同一篇第二次保存必被误判「在你编辑期间已被改动」。 */
  return { success: true, sha: body.content.sha, path: body.content.path };
}

/**
 * 一次提交写多个文件（Git Data API：blob → tree → commit → 移动 ref）。
 *
 * 为什么需要它：contents API 的 `PUT /contents/<path>` **一次只能写一个文件、一个提交**，
 * 而每个提交都会触发一次 Pages 构建。后台「批量推送」与「前端设置」都是一次改多个文件，
 * 以前逐个 PUT = N 个提交 = N 次构建，批量的意义全没了。
 *
 * 语义与 writeFile 保持一致：返回每个文件的 blob 号（前端拿它当下一轮的乐观锁基准），
 * 调用方已在外面做过 sha 冲突检查，这里只负责把这一批原子地落成一个提交。
 */
export async function commitFiles(input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  message: string;
  files: { path: string; content: string }[];
  deletes?: string[];
}): Promise<{ success: boolean; commit?: string; shas?: Record<string, string>; unchanged?: boolean; error?: string }> {
  const files = input.files.filter((f) => f.path);
  const deletes = (input.deletes ?? []).filter(Boolean);
  if (!files.length && !deletes.length) return { success: true, shas: {} };

  const base = `${API}/repos/${input.owner}/${input.repo}`;
  const auth = headers(input.token, 'application/vnd.github+json');
  const where = { owner: input.owner, repo: input.repo, branch: input.branch };

  const refRes = await fetch(`${base}/git/ref/heads/${encodeURIComponent(input.branch)}`, { headers: auth });
  if (!refRes.ok) return { success: false, error: await readError(refRes, where) };
  const headSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;

  const commitRes = await fetch(`${base}/git/commits/${headSha}`, { headers: auth });
  if (!commitRes.ok) return { success: false, error: await readError(commitRes, where) };
  const baseTree = ((await commitRes.json()) as { tree: { sha: string } }).tree.sha;

  const tree: { path: string; mode?: string; type?: string; sha: string | null }[] = [];
  const shas: Record<string, string> = {};
  for (const f of files) {
    const bytes = new TextEncoder().encode(f.content);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const blobRes = await fetch(`${base}/git/blobs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: btoa(binary), encoding: 'base64' }),
    });
    if (!blobRes.ok) return { success: false, error: await readError(blobRes, { ...where, path: f.path }) };
    const sha = ((await blobRes.json()) as { sha: string }).sha;
    shas[f.path] = sha;
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }
  /* 删除也要带 mode/type：只写 {path, sha:null} 会被 GitHub 回 422「Must supply a valid tree.mode」 */
  for (const p of deletes) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });

  const treeRes = await fetch(`${base}/git/trees`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  if (!treeRes.ok) return { success: false, error: await readError(treeRes, where) };
  const treeSha = ((await treeRes.json()) as { sha: string }).sha;
  /* 内容与现在完全一样时 tree 不会变 —— 不产生空提交，也不白触发一次构建 */
  if (treeSha === baseTree) return { success: true, commit: headSha, shas, unchanged: true };

  const newCommitRes = await fetch(`${base}/git/commits`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ message: input.message, tree: treeSha, parents: [headSha] }),
  });
  if (!newCommitRes.ok) return { success: false, error: await readError(newCommitRes, where) };
  const newCommit = ((await newCommitRes.json()) as { sha: string }).sha;

  const moveRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(input.branch)}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ sha: newCommit, force: false }),
  });
  if (!moveRes.ok) {
    /* 期间有别的提交（CMS、定时任务）动过这个分支：不覆盖，交回调用方重试 */
    return { success: false, error: `仓库在这几秒里被其他提交更新过，这次没有写入。请重试一次（目标：${where.owner}/${where.repo}@${where.branch}）` };
  }
  return { success: true, commit: newCommit, shas };
}

export async function deleteFile(input: { owner: string; repo: string; path: string; message: string; branch: string; token: string }): Promise<CommitResult> {
  const path = encodeURIComponentPath(input.path);
  const url = `${API}/repos/${input.owner}/${input.repo}/contents/${path}?ref=${encodeURIComponent(input.branch)}`;
  const probe = await fetch(url, { headers: headers(input.token, 'application/vnd.github+json') });
  if (probe.status === 404) return { success: false, error: '文件不存在' };
  if (!probe.ok) return { success: false, error: await readError(probe, input) };
  const { sha } = (await probe.json()) as { sha: string };

  const res = await fetch(`${url}&sha=${sha}`, {
    method: 'DELETE',
    headers: headers(input.token, 'application/vnd.github+json'),
    body: JSON.stringify({ message: input.message, branch: input.branch, sha }),
  });
  if (!res.ok) return { success: false, error: await readError(res, input) };
  return { success: true };
}

/** 列目录，供后台文件树使用 */
export async function listDir(input: { owner: string; repo: string; path: string; branch: string; token: string }): Promise<{ name: string; path: string; type: 'file' | 'dir' }[]> {
  const url = `${API}/repos/${input.owner}/${input.repo}/contents/${encodeURIComponentPath(input.path)}?ref=${encodeURIComponent(input.branch)}`;
  const res = await fetch(url, { headers: headers(input.token, 'application/vnd.github+json') });
  if (!res.ok) throw new Error(await readError(res, input));
  const body = (await res.json()) as { name: string; path: string; type: string }[];
  if (!Array.isArray(body)) return [];
  return body.map((e) => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'dir' : 'file' }));
}

/** 路径要保留目录分隔，只能逐段编码 */
function encodeURIComponentPath(p: string): string {
  return p
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
