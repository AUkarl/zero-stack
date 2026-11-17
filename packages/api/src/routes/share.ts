import { Hono } from 'hono';
import { getConfig } from '../services/config';
import { kvGet, kvPut } from '../services/kv-cache';
import { fail, ok } from '../lib/errors';
import { toHex } from '../lib/crypto';
import { fetchWithTimeout } from '../lib/fetch';
import { rateLimit } from '../lib/rate-limit';
import type { AppEnv } from '../lib/app';

/**
 * 微信 JS-SDK 签名：公众号后台配好 AppID / AppSecret、把站点域名加进「JS 接口安全域名」后，
 * 前台才能自定义分享卡片的标题、描述与缩略图。没有配置时前台自动降级，不影响分享按钮本身。
 */
const app = new Hono<AppEnv>();

const tokenKey = (appId: string) => `zero:wechat:token:${appId}`;
const ticketKey = (appId: string) => `zero:wechat:ticket:${appId}`;

async function jsonOrThrow(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || body.errcode) {
    const reason = body ? `${body.errcode ?? res.status} ${body.errmsg ?? ''}`.trim() : `HTTP ${res.status}`;
    throw new Error(`${what}：${reason}`);
  }
  return body;
}

async function tokenOf(env: Env, appId: string, secret: string): Promise<string> {
  const cached = await kvGet(env, tokenKey(appId));
  if (typeof cached === 'string' && cached) return cached;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
  const body = await jsonOrThrow(await fetchWithTimeout(url), '获取 access_token 失败');
  const token = String(body.access_token ?? '');
  if (!token) throw new Error('获取 access_token 失败：返回为空');
  await kvPut(env, tokenKey(appId), token, 7000);
  return token;
}

async function ticketOf(env: Env, appId: string, token: string): Promise<string> {
  const cached = await kvGet(env, ticketKey(appId));
  if (typeof cached === 'string' && cached) return cached;
  const url = `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${encodeURIComponent(token)}&type=jsapi`;
  const body = await jsonOrThrow(await fetchWithTimeout(url), '获取 jsapi_ticket 失败');
  const ticket = String(body.ticket ?? '');
  if (!ticket) throw new Error('获取 jsapi_ticket 失败：返回为空');
  await kvPut(env, ticketKey(appId), ticket, 7000);
  return ticket;
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

app.get('/wechat', async (c) => {
  await rateLimit(c, 'wechat-share', 120, 3600);
  const appId = String((await getConfig(c.env, 'wechatShareAppId')) ?? '').trim();
  const secret = String((await getConfig(c.env, 'wechatShareSecret')) ?? '').trim();
  if (!appId || !secret) fail(400, '微信分享未配置');

  const raw = (c.req.query('url') ?? '').trim();
  if (!raw) fail(400, '缺少 url');
  let page: URL;
  try {
    page = new URL(raw);
  } catch {
    fail(400, 'url 不合法');
  }
  const site = new URL(String((await getConfig(c.env, 'siteUrl')) ?? 'https://example.com'));
  const local = c.env.ENVIRONMENT !== 'production' && /^(localhost|127\.0\.0\.1)$/.test(page!.hostname);
  if (page!.protocol !== 'https:' && !local) fail(400, 'url 必须使用 https');
  if (!local && page!.hostname !== site.hostname && page!.hostname !== `www.${site.hostname}`) {
    fail(400, 'url 不属于本站');
  }

  const url = page!.href.split('#')[0];
  try {
    const token = await tokenOf(c.env, appId, secret);
    const ticket = await ticketOf(c.env, appId, token);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = nonce();
    const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(plain));
    return ok({ appId, timestamp, nonceStr, signature: toHex(new Uint8Array(digest)) });
  } catch (e) {
    fail(502, e instanceof Error ? e.message : '微信签名失败');
  }
});

export default app;
