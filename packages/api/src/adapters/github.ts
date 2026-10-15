/**
 * GitHub Contents API 适配：zero-cms 发布的文章最终落到私密站点仓库，
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

function headers(token: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Request-Type': 'zero-cms',
    'Content-Type': 'application/json',
  };
}

async function readError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: string; errors?: { message: string }[] };
    detail = body.message ?? '';
    if (body.errors?.length) detail += `（${body.errors.map((e) => e.message).join('; ')}）`;
  } catch {
    detail = res.statusText;
  }
  if (res.status === 401) return 'GitHub 令牌无效或已过期，请重新生成并更新 GITHUB_TOKEN 密钥';
  if (res.status === 403) return `GitHub 拒绝访问（多为令牌权限不足或触发限流）：${detail}`;
  if (res.status === 404) return `仓库或路径不存在：${detail}`;
  return `GitHub ${res.status}：${detail}`;
}

/** 取当前文件内容与 sha，Hugo 的 md 是 UTF-8 文本，直接按 content 接口读 */
export async function readFile(input: Omit<CommitInput, 'content' | 'message'>): Promise<{ content: string; sha: string } | null> {
  const url = `${API}/repos/${input.owner}/${input.repo}/contents/${encodeURIComponentPath(input.path)}?ref=${encodeURIComponent(input.branch)}`;
  const res = await fetch(url, { headers: headers(input.token, 'application/vnd.github+json') });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res));

  const body = (await res.json()) as { content?: string; encoding?: string; sha: string };
  const text = body.content ? atob(body.content.replace(/\n/g, '')) : '';
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
    if (body.content) current = atob(body.content.replace(/\n/g, ''));
  } else if (probe.status !== 404) return { success: false, error: await readError(probe) };

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

  if (!res.ok) return { success: false, error: await readError(res) };
  const body = (await res.json()) as { commit: { sha: string }; content: { path: string } };
  return { success: true, sha: body.commit.sha, path: body.content.path };
}

export async function deleteFile(input: { owner: string; repo: string; path: string; message: string; branch: string; token: string }): Promise<CommitResult> {
  const path = encodeURIComponentPath(input.path);
  const url = `${API}/repos/${input.owner}/${input.repo}/contents/${path}?ref=${encodeURIComponent(input.branch)}`;
  const probe = await fetch(url, { headers: headers(input.token, 'application/vnd.github+json') });
  if (probe.status === 404) return { success: false, error: '文件不存在' };
  if (!probe.ok) return { success: false, error: await readError(probe) };
  const { sha } = (await probe.json()) as { sha: string };

  const res = await fetch(`${url}&sha=${sha}`, {
    method: 'DELETE',
    headers: headers(input.token, 'application/vnd.github+json'),
    body: JSON.stringify({ message: input.message, branch: input.branch, sha }),
  });
  if (!res.ok) return { success: false, error: await readError(res) };
  return { success: true };
}

/** 列目录，供后台文件树使用 */
export async function listDir(input: { owner: string; repo: string; path: string; branch: string; token: string }): Promise<{ name: string; path: string; type: 'file' | 'dir' }[]> {
  const url = `${API}/repos/${input.owner}/${input.repo}/contents/${encodeURIComponentPath(input.path)}?ref=${encodeURIComponent(input.branch)}`;
  const res = await fetch(url, { headers: headers(input.token, 'application/vnd.github+json') });
  if (!res.ok) throw new Error(await readError(res));
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
