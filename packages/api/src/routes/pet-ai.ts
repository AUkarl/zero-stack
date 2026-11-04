/**
 * AI PET 台词接口。
 *
 * 前台桌宠不再走 Pages Functions 里那份独立的 mock/环境变量，而是回到后台
 * 「设置 → AI 模型配置」和「互动 → AI 回复 → AI 身份设置」这一套：
 * 服务商、端点、模型、密钥、昵称、身份组、人设补充全部以后台为准。
 *
 * 公开接口，但带按 IP 的滑动窗口限流；密钥只留在 Worker 里。
 */
import { Hono } from 'hono';
import { aiChat, aiConfig } from '../services/ai';
import { getConfig } from '../services/config';
import { rateLimitLocal } from '../lib/rate-limit';
import { cleanMultiline } from '../lib/sanitize';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

const MOODS = new Set(['happy', 'curious', 'surprised', 'pout', 'sleepy']);
const ACTIONS = new Set(['float', 'wave', 'jump', 'tilt', 'spin']);
const TRIGGERS = new Set(['greeting', 'poke', 'comment', 'theme', 'chat', 'feed', 'scroll', 'like', 'star', 'top']);

const TRIGGER_HINTS: Record<string, string> = {
  feed: '读者刚给你喂了一碗白米饭，你正开心地吃。',
  scroll: '读者刚把这一页读到底了，可以陪他松一口气。',
  like: '读者刚点了赞，你被看见了。',
  star: '读者刚把这一页收藏起来了，你被珍藏了。',
  comment: '评论区刚出现一条新评论，你也想去看看。',
  top: '读者刚点了回到顶部/到底部按钮。',
  theme: '读者刚切换了明暗主题，页面换了一种颜色。',
  greeting: '读者刚打开这个页面，第一次见到你。',
};

function oneLine(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseModelLine(raw: string, max: number): { line: string; mood: string; action: string } {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { parsed = null; }
  }
  const line = oneLine(parsed?.line ?? text, max);
  if (!line) throw new Error('empty model output');
  return {
    line,
    mood: MOODS.has(String(parsed?.mood)) ? String(parsed?.mood) : 'curious',
    action: ACTIONS.has(String(parsed?.action)) ? String(parsed?.action) : 'float',
  };
}

app.post('/pet-line', async (c) => {
  // 桌宠在页面里会不停互动；按 IP 给一个宽松但能挡住无脑刷的窗口。
  rateLimitLocal(c, 'pet-line', 80, 600);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'bad request' }, 400);

  const cfg = await aiConfig(c.env);
  if (!cfg.ready) return c.json({ error: 'ai not configured' }, 503);

  const trigger = TRIGGERS.has(String(body.trigger)) ? String(body.trigger) : 'poke';
  const question = oneLine(body.question, 100);
  const isQuestion = question.length > 0;
  const title = oneLine(body.title, 120);
  const section = oneLine(body.section, 24);
  const theme = body.theme === 'dark' ? 'dark' : body.theme === 'light' ? 'light' : 'auto';
  const [rawName, rawGroup, rawPersona] = await Promise.all([
    getConfig(c.env, 'aiReplyName'),
    getConfig(c.env, 'aiReplyGroup'),
    getConfig(c.env, 'aiReplyPrompt'),
  ]);
  const name = oneLine(rawName, 40) || '阿溟';
  const group = oneLine(rawGroup, 24);
  const persona = cleanMultiline(rawPersona ?? '', 2000);
  const state = body.state && typeof body.state === 'object' ? (body.state as Record<string, unknown>) : {};
  const stateLine = [
    `心情 ${oneLine(state.mood, 20) || '平静'}`,
    `精力 ${Math.max(0, Math.min(100, Number(state.energy) || 0))}/100`,
    `饱腹 ${Math.max(0, Math.min(100, Number(state.satiety) || 0))}/100`,
    `无聊 ${Math.max(0, Math.min(100, Number(state.boredom) || 0))}/100`,
    `场景 ${oneLine(state.scene, 20) || 'page'}`,
    `离开 ${Number(state.awayHours) || 0} 小时`,
    `累计互动 ${Number(state.interactions) || 0} 次`,
    Number(state.pokes) > 2 ? `刚才被连续戳了 ${Number(state.pokes)} 下` : '',
  ].filter(Boolean).join('；');

  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  if (Array.isArray(body.history)) {
    for (const turn of body.history.slice(-8)) {
      if (!turn || typeof turn !== 'object') continue;
      const row = turn as Record<string, unknown>;
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : '';
      const content = oneLine(row.content, 240);
      if (role && content) history.push({ role, content });
    }
  }

  const system = [
    `你是站长博客里的鲸鱼娘「${name}」。` + (group ? `你的身份标识是「${group}」。` : ''),
    persona ? `站长给你的人设与说话要求（优先遵守）：\n${persona}` : '你说话短、轻、俏皮，像在网站角落里陪读者聊天。',
    history.length ? '你们刚才已经聊过几轮，下面会带上对话历史；回答要自然承接，不要重复自己说过的话。' : '',
    isQuestion ? '读者在向你提问：先用一句中文直接回答他的问题（保持人设），不要装没听见、不要答非所问；只有确实不知道时才俏皮地说不知道。不超过 90 个字，不许编造站内没有的信息。' : '每次只说一句中文，不超过 30 个字；不用 Markdown，不用引号，不解释，不说自己是 AI。',
    '只返回严格 JSON，不要代码块：',
    '{"line":"一句台词","mood":"happy|curious|surprised|pout|sleepy","action":"float|wave|jump|tilt|spin"}',
  ].filter(Boolean).join('\n');

  const user = [
    title ? `当前页面：${title}` : '',
    section ? `栏目：${section}` : '',
    `当前主题：${theme}`,
    `触发方式：${trigger}`,
    TRIGGER_HINTS[trigger] ?? '',
    `你的状态：${stateLine}`,
    isQuestion ? `读者问：${question}` + (history.length ? '（请结合上面的对话历史回答，不要重复上一句）' : '') : '请结合当前页面和状态，说一句符合人设的话。',
  ].filter(Boolean).join('\n');

  try {
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: user },
    ];
    const text = await aiChat(
      c.env,
      messages,
      { temperature: 0.8, maxTokens: isQuestion ? 220 : 140, timeoutMs: 15_000 },
    );
    return c.json(parseModelLine(text, isQuestion ? 90 : 60));
  } catch (e) {
    console.warn('[zero-api] AI PET 台词生成失败：', e instanceof Error ? e.message : String(e));
    return c.json({ error: 'upstream failed' }, 502);
  }
});

export default app;
