/**
 * 保存前的本地校验：规则与 packages/api 的 zod 一致（超长 / 超量 / 结构不合法），
 * 先在前端拦下来并用中文说明，免得用户点保存才看到后端报错。
 *
 * 返回分两类：
 *   issues —— 拦下保存；
 *   notes  —— 只提示，不拦（比如「有空白条目会被忽略」）。
 */

import { CAP, LIMIT, payloadOf, type Forms, type Issue, type SectionKey } from './types';

export type { Issue };

export function validateSection(key: SectionKey, form: Forms[SectionKey]): Issue[] {
  // 校验清洗后的值：和真正提交出去的内容一致（payloadOf 已经 trim / 丢空行 / 收敛枚举）
  const v = payloadOf(key, form);
  const out: Issue[] = [];
  const push = (message: string) => out.push({ section: key, message });

  if (key === 'nav') {
    const f = v as Forms['nav'];
    if (f.items.length > CAP.nav) push(`导航栏最多 ${CAP.nav} 项，当前 ${f.items.length} 项（与后端限制一致）`);
    if (!f.items.length) push('导航栏至少要留 1 个菜单项；想让前台改用 params.toml，请点本页的「删除覆盖」而不是保存空列表');
    const identifiers = new Map<string, number[]>();
    const children = new Map<string, number>();
    f.items.forEach((it, i) => {
      if (it.identifier) {
        identifiers.set(it.identifier, [...(identifiers.get(it.identifier) ?? []), i + 1]);
      }
      if (it.parent) children.set(it.parent, (children.get(it.parent) ?? 0) + 1);
    });
    f.items.forEach((it, i) => {
      const at = `第 ${i + 1} 项${it.name ? `「${it.name}」` : ''}`;
      if (it.name.length > LIMIT.short) push(`${at}：名称超过 ${LIMIT.short} 字`);
      if (it.url.length > LIMIT.href) push(`${at}：链接超过 ${LIMIT.href} 字`);
      if (it.icon.length > LIMIT.short) push(`${at}：图标名超过 ${LIMIT.short} 字`);
      if (it.image.length > LIMIT.href) push(`${at}：图片地址超过 ${LIMIT.href} 字`);
      if (it.identifier.length > LIMIT.short) push(`${at}：标识（identifier）超过 ${LIMIT.short} 字`);
      if (it.parent.length > LIMIT.short) push(`${at}：父项（parent）超过 ${LIMIT.short} 字`);
      if (!it.name.trim()) push(`${at}：没填名称。只显示图标时名称也会用作鼠标提示和无障碍标签，也要填`);
      if (!it.url && !it.identifier) push(`${at}：没填链接，也不是父项 —— 要么填链接，要么填标识（identifier）并添加 parent 指向它的子项`);
      if (it.parent && !identifiers.has(it.parent)) {
        push(`${at}：父项 parent="${it.parent}" 在本段里找不到对应的标识（identifier），保存后这一项会挂不上去`);
      }
      const ids = it.identifier ? identifiers.get(it.identifier) ?? [] : [];
      if (it.identifier && ids.length > 1) push(`${at}：标识「${it.identifier}」被第 ${ids.join('、')} 项共用，主题会把它们当成同一项`);
    });
    return out;
  }

  if (key === 'home') {
    const f = v as Forms['home'];
    if (f.desc.length > LIMIT.short) push(`首页描述超过 ${LIMIT.short} 字（后端按短文本存）`);
    if (f.layout !== 'bento' && f.layout !== 'grid') push('首页布局只能是 bento 或 grid');
    return out;
  }

  if (key === 'footer') {
    const f = v as Forms['footer'];
    if (f.copyrightText.length > LIMIT.short) push(`版权文字超过 ${LIMIT.short} 字`);
    if (f.poweredByText.length > LIMIT.short) push(`powered by 文字超过 ${LIMIT.short} 字`);
    if (f.poweredByLink.length > LIMIT.href) push(`powered by 链接超过 ${LIMIT.href} 字`);
    if (f.icpItems.length > CAP.icp) push(`备案条目最多 ${CAP.icp} 条，当前 ${f.icpItems.length} 条`);
    f.icpItems.forEach((x, i) => {
      if (x.text.length > LIMIT.short) push(`备案第 ${i + 1} 条文字超过 ${LIMIT.short} 字`);
      if (x.link.length > LIMIT.href) push(`备案第 ${i + 1} 条链接超过 ${LIMIT.href} 字`);
    });
    /** 三组图标行共用同一套上限与长度规则 */
    for (const [label, list] of [
      ['支持服务', f.services],
      ['社交第一排', f.socialRow1],
      ['社交第二排', f.socialRow2],
    ] as const) {
      if (list.length > CAP.icons) push(`${label}最多 ${CAP.icons} 条，当前 ${list.length} 条`);
      list.forEach((x, i) => {
        if (x.name.length > LIMIT.short) push(`${label}第 ${i + 1} 条名称超过 ${LIMIT.short} 字`);
        if (x.link.length > LIMIT.href) push(`${label}第 ${i + 1} 条地址超过 ${LIMIT.href} 字`);
        if (x.img.length > LIMIT.href) push(`${label}第 ${i + 1} 条图片路径超过 ${LIMIT.href} 字`);
      });
    }
    return out;
  }

  if (key === 'about') {
    const f = v as Forms['about'];
    if (f.desc.length > LIMIT.short) push(`关于页描述超过 ${LIMIT.short} 字`);
    if (f.tagline.length > LIMIT.short) push(`签名超过 ${LIMIT.short} 字`);
    const groups: ['bio' | 'declaration' | 'site', string][] = [
      ['bio', '关于我'],
      ['site', '关于本站'],
      ['declaration', '站点声明'],
    ];
    for (const [field, label] of groups) {
      const list = f[field];
      if (list.length > CAP.paragraph) push(`${label}最多 ${CAP.paragraph} 段，当前 ${list.length} 段`);
      list.forEach((p, i) => {
        if (p.length > LIMIT.long) push(`${label}第 ${i + 1} 段超过 ${LIMIT.long} 字（当前 ${p.length} 字）`);
      });
    }
    if (f.contacts.length > CAP.contacts) push(`找到我条目最多 ${CAP.contacts} 条，当前 ${f.contacts.length} 条`);
    f.contacts.forEach((x, i) => {
      if (x.label.length > LIMIT.short) push(`找到我第 ${i + 1} 条的分组名超过 ${LIMIT.short} 字`);
      if (x.text.length > LIMIT.short) push(`找到我第 ${i + 1} 条的显示文字超过 ${LIMIT.short} 字`);
      if (x.url.length > LIMIT.href) push(`找到我第 ${i + 1} 条的链接超过 ${LIMIT.href} 字`);
    });
    return out;
  }

  if (key === 'site') {
    const f = v as Forms['site'];
    if (f.name.length > LIMIT.short) push(`站点名超过 ${LIMIT.short} 字`);
    if (f.navName.length > LIMIT.short) push(`导航栏站点名超过 ${LIMIT.short} 字`);
    if (f.description.length > LIMIT.long) push(`站点简介超过 ${LIMIT.long} 字（当前 ${f.description.length} 字）`);
    if (f.logo.length > LIMIT.href) push(`Logo 地址超过 ${LIMIT.href} 字`);
    if (f.favicon.length > LIMIT.href) push(`favicon 地址超过 ${LIMIT.href} 字`);
    if (f.ogImage.length > LIMIT.href) push(`分享图地址超过 ${LIMIT.href} 字`);
    if (f.keywords.length > 40) push(`关键词最多 40 个，当前 ${f.keywords.length} 个`);
    return out;
  }

  if (key === 'moments') {
    const f = v as Forms['moments'];
    if (f.defaultLocation.length > LIMIT.short) push(`默认位置文案超过 ${LIMIT.short} 字`);
    if (f.nickname.length > LIMIT.short) push(`昵称超过 ${LIMIT.short} 字`);
    if (f.bannerImage.length > LIMIT.href) push(`横幅背景图地址超过 ${LIMIT.href} 字`);
    if (f.avatar.length > LIMIT.href) push(`头像地址超过 ${LIMIT.href} 字`);
    if (f.paginate < 1 || f.paginate > 100) push('每批条数只能是 1 到 100');
    return out;
  }

  if (key === 'seo') {
    // 这一段落盘是 snake_case（要和 params.toml 的 [seo] 逐键同名），所以按表单值校验
    const f = form as Forms['seo'];
    const hex = (s: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
    if (f.defaultDescription.length > LIMIT.long) push(`默认描述超过 ${LIMIT.long} 字`);
    if (f.descriptionLength < 40 || f.descriptionLength > 400) push('描述截断长度只能是 40 到 400');
    if (f.titleSeparator.length > LIMIT.short) push(`标题分隔符超过 ${LIMIT.short} 字`);
    if (!f.titleSeparator.trim()) push('标题分隔符不能是空的，否则页面标题会连成一串');
    if (f.siteAuthor.length > LIMIT.short) push(`默认作者超过 ${LIMIT.short} 字`);
    if (f.ogImageDefault.length > LIMIT.href) push(`默认分享图地址超过 ${LIMIT.href} 字`);
    if (f.publisherLogo.length > LIMIT.href) push(`出版方 Logo 地址超过 ${LIMIT.href} 字`);
    if (f.robotsDefault.length > LIMIT.short) push(`robots 默认指令超过 ${LIMIT.short} 字`);
    if (!f.robotsDefault.trim()) push('robots 默认指令不能是空的（一般写 index, follow）');
    if (f.robotsCrawlDelay < 0 || f.robotsCrawlDelay > 100) push('抓取延迟只能是 0 到 100 秒，0 表示不输出这一行');
    if (f.robotsHost.length > LIMIT.href) push(`Host 地址超过 ${LIMIT.href} 字`);
    if (f.twitterSite.length > LIMIT.short) push(`站点 Twitter 账号超过 ${LIMIT.short} 字`);
    if (f.twitterCreator.length > LIMIT.short) push(`创作者 Twitter 账号超过 ${LIMIT.short} 字`);
    if (!hex(f.themeColorLight)) push('浅色主题色要写成 #fff 或 #ffffff 这样的十六进制');
    if (!hex(f.themeColorDark)) push('深色主题色要写成 #fff 或 #ffffff 这样的十六进制');
    if (f.colorScheme.length > LIMIT.short) push(`color-scheme 超过 ${LIMIT.short} 字`);
    f.robotsDisallow.forEach((p, i) => {
      if (p.trim() && !p.trim().startsWith('/')) push(`robots 禁止路径第 ${i + 1} 条「${p}」要以 / 开头，否则不生效`);
    });
    f.robotsAllow.forEach((p, i) => {
      if (p.trim() && !p.trim().startsWith('/')) push(`robots 允许路径第 ${i + 1} 条「${p}」要以 / 开头，否则不生效`);
    });
    return out;
  }

  const f = v as Forms['works'];
  if (f.desc.length > LIMIT.short) push(`工坊页描述超过 ${LIMIT.short} 字`);
  if (f.items.length > CAP.works) push(`工坊项目最多 ${CAP.works} 个，当前 ${f.items.length} 个`);
  f.items.forEach((x, i) => {
    const at = `第 ${i + 1} 个项目${x.title ? `「${x.title}」` : ''}`;
    if (!x.title.trim()) push(`${at}：没填标题`);
    if (x.title.length > LIMIT.short) push(`${at}：标题超过 ${LIMIT.short} 字`);
    if (x.desc.length > LIMIT.long) push(`${at}：简介超过 ${LIMIT.long} 字（当前 ${x.desc.length} 字）`);
    if (x.status.length > LIMIT.short) push(`${at}：状态文字超过 ${LIMIT.short} 字`);
    if (x.url.length > LIMIT.href) push(`${at}：链接超过 ${LIMIT.href} 字`);
  });
  return out;
}

/** 非阻断提示：能存，但结果和预期可能不一样，值得先让用户看见 */
export function notesOf(key: SectionKey, form: Forms[SectionKey]): string[] {
  const out: string[] = [];
  if (key === 'nav') {
    const f = form as Forms['nav'];
    const ids = new Set(f.items.filter((x) => x.identifier).map((x) => x.identifier));
    const nested = f.items.filter((x) => x.parent && ids.has(x.parent));
    const parentsOfParent = f.items.filter((x) => x.identifier && x.parent);
    const twoLevel = nested.some((x) => parentsOfParent.some((p) => p.identifier === x.parent));
    if (twoLevel) out.push('检测到「子项下面还有子项」：前台导航只渲染两级，第三级不会出现');
    const noUrlParent = f.items.filter((x) => x.identifier && !x.url);
    for (const it of noUrlParent) {
      if (!f.items.some((x) => x.parent === it.identifier)) out.push(`「${it.name || it.identifier}」只填了标识、没有链接也没有子项，前台会是个点不动的空项`);
    }
    const controls = f.items.filter((x) => x.position === 'controls');
    if (controls.length) {
      out.push(`右侧图标区有 ${controls.length} 项：主题自带的两个图标开关默认 weight 90 / 100，想插到它们中间就直接改这一项的 weight`);
    }
    if (f.items.some((x) => x.zeroAccount)) out.push('这一项带着「账号入口」标记：主题会把它当登录图标（登录后换成头像）。登录入口本身不用在这里配 —— 主题固定补一项，只看「设置 → 前台账号系统」');
  }
  if (key === 'footer') {
    const f = form as Forms['footer'];
    if (f.showPoweredBy && !f.poweredByText.trim()) out.push('打开了 powered by 开关但文字为空：前台这一行不会出现');
    const noLink = [...f.services, ...f.socialRow1, ...f.socialRow2].filter((x) => !x.link.trim());
    if (noLink.length) out.push(`有 ${noLink.length} 条图标没填地址：主题会跳过整条，前台看不到它们（保存时也会被丢掉）`);
    const noIcon = [...f.services, ...f.socialRow1, ...f.socialRow2].filter((x) => x.link.trim() && !x.icon.trim() && !x.img.trim());
    if (noIcon.length) out.push(`有 ${noIcon.length} 条图标既没填类名也没填图片：前台会是一个空白点击区`);
  }
  if (key === 'home') {
    const f = form as Forms['home'];
    if (f.showDesc && !f.desc.trim()) out.push('打开了首页描述开关但文字为空：前台这一行不会出现');
  }
  if (key === 'about') {
    const f = form as Forms['about'];
    if (f.contacts.some((c) => !c.label.trim()) && f.contacts.some((c) => c.label.trim())) {
      out.push('「找到我」按分组名归组显示：没填分组名的条目会单独成组，建议和同组其它条目写成一样的 label');
    }
  }
  if (key === 'site') {
    const f = form as Forms['site'];
    if (!f.name.trim() && !f.logo.trim() && !f.favicon.trim() && !f.description.trim() && !f.siteUrl.trim()) {
      out.push('整份都是空的：每一项留空时前台回落到 params.toml 的对应值，保存这一份不会改变现在的显示');
    }
  }
  if (key === 'moments') {
    const f = form as Forms['moments'];
    if (!f.showLocation && f.defaultLocation.trim()) out.push('位置开关已经关掉，兜底文案不会显示（保存时仍会带着这句文字）');
  }
  return out;
}
