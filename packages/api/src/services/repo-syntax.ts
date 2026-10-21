import { parse as parseToml } from 'smol-toml';
import { validateLinksYaml } from './links-yaml';

/**
 * 「主题配置文件」那一路（PUT /api/admin/repo/file）的入口语法体检。
 *
 * 为什么必须在这一层：白名单放行的 4 份文件里，3 份是 Hugo 的**配置文件**
 * （config/_default/params.toml、config.toml、menus.zh.toml）—— 它们坏了，Hugo 是
 * `failed to load config … unmarshal failed`，**整站一个页面都不产出**；第 4 份 links.yaml 坏了
 * 是友链整页没。而 Pages 的规矩是「构建失败就不换部署」，于是站点从这一刻起静默停止更新：
 * 后台一直显示「已保存」，前台与 sitemap 停在旧版，谁都不提示。实测见 测试1/R32 报告 P1-1。
 *
 * 判据一律用真解析器（smol-toml，零依赖、gzip 约 16KB），不自写「看着像 TOML」的结构检查 ——
 * 自写的会把带注释、多行字符串、CRLF 行尾的合法文件误杀，那种误杀会把站长正当的编辑挡在门外。
 * 已经拿站长真站那份 params.toml（13999 字节、CRLF 行尾）与模板出厂那几份验过：都能解析通过。
 *
 * YAML 侧不引第三方库：links.yaml 本来就是我们自己生成的固定结构（见 links-yaml.ts 顶部注释），
 * 所以用同文件里那份只挡「一定会炸」三件事的 validateLinksYaml。
 *
 * 返回 null = 允许落盘；返回字符串 = 一句人能照着改的话，直接当 400 的 message 用。
 */
export function checkRepoFileSyntax(path: string, content: string): string | null {
  const p = String(path ?? '').trim().replace(/\\/g, '/');

  if (/\.toml$/i.test(p)) {
    try {
      parseToml(content);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `${p} 不是合法的 TOML，站点会整份构建失败（Hugo 会停在 failed to load config），所以这次没写进仓库：${cleanTomlMessage(msg)}`;
    }
  }

  if (/\.ya?ml$/i.test(p)) {
    const bad = validateLinksYaml(content);
    return bad ? `${p} 这样写 Hugo 读不出来，友链整页会没，所以这次没写进仓库：${bad}` : null;
  }

  return null;
}

/** smol-toml 的错误原文形如 `Unexpected value on line 2, column 6: 'toml'`，只留有用的一段 */
function cleanTomlMessage(msg: string): string {
  const m = String(msg ?? '').replace(/\s+/g, ' ').trim();
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}
