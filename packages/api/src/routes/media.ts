import { Hono } from 'hono';
import { getMediaObject, resolveBucket } from '../services/media';
import { fail } from '../lib/errors';
import type { AppEnv } from '../lib/app';

/**
 * GET /api/media/<bucket>/<key> —— 媒体的公开只读代理。
 *
 * 文章 Markdown 里存的图片地址必须能被访客直接打开，而 /api/admin/media/*
 * 要管理员 Cookie，所以正文只能用这条公开路由。桶没有配 baseUrl 时，
 * 对象只能靠 Worker 转发，这里就是那个转发。
 */
const app = new Hono<AppEnv>();

/** 脚本类型一律降级成纯文本：Worker 与站点同源时，上传一个 .svg 就等于存了一条 XSS */
const UNSAFE = /^image\/svg\+xml$|^image\/svg$|^(application|text)\/(x?html|xml|javascript|ecmascript)/i;

app.get('/*', async (c) => {
  const path = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/api\/media\/?/, ''));
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) fail(400, '缺少桶名或对象键');
  const bucket = await resolveBucket(c.env, segments[0]!);
  const key = segments.slice(1).join('/');
  const object = await getMediaObject(c.env, bucket, key);
  if (!object) fail(404, '文件不存在');

  const type = UNSAFE.test(object.contentType ?? '') ? 'text/plain; charset=utf-8' : object.contentType;
  return new Response(object.data as BodyInit, {
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
});

export default app;
