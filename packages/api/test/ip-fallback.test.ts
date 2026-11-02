/**
 * clientIp 与「兜底 IP 计数」的接线判据（R76-5）。
 *
 * 为什么这条只能写在单测里：本地 workerd（wrangler dev）会替每个请求补上 `cf-connecting-ip`
 * （台架实测：即使显式发一个空值，进到 Worker 的还是 127.0.0.1），所以在台架里根本造不出
 * 「没带这个头」的请求 —— 端到端那一路验不到它，只能把 Context 造出来直接验接线。
 * 这一条恰恰是给「绕过 Cloudflare 边缘直连接口」那种部署用的，本地跑不到不等于不需要。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'hono';
import { clientIp, ipFallbackCount } from '../src/lib/http';

type KvStub = { store: Map<string, string>; get: (k: string) => Promise<string | null>; put: (k: string, v: string) => Promise<void> };

function fakeKv(): KvStub {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  };
}

/** 造一个只带 headers 的最小 Context；waitUntil 收下来自己等，免得断言跑在写入之前 */
function fakeCtx(headers: Record<string, string>, kv: KvStub, pending: Promise<unknown>[]) {
  const raw = new Headers(headers);
  return {
    req: { raw: { headers: raw } },
    env: { CACHE: kv },
    executionCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
  } as unknown as Context;
}

const flush = async (pending: Promise<unknown>[]) => {
  await Promise.all(pending);
  await new Promise((r) => setTimeout(r, 0));
};

test('带了 cf-connecting-ip 的请求：按真值返回，一次 KV 都不写', async () => {
  const kv = fakeKv();
  const pending: Promise<unknown>[] = [];
  const c = fakeCtx({ 'cf-connecting-ip': '203.0.113.55' }, kv, pending);
  assert.equal(clientIp(c), '203.0.113.55');
  await flush(pending);
  assert.equal(kv.store.size, 0, '正常经边缘的请求不该产生计数写');
});

test('没带这个头：回兜底常量，并且把这一笔计进 KV（同小时累加）', async () => {
  const kv = fakeKv();
  const pending: Promise<unknown>[] = [];
  const c = fakeCtx({}, kv, pending);
  assert.equal(clientIp(c), '203.0.113.1');
  await flush(pending);
  assert.equal(clientIp(c), '203.0.113.1');
  await flush(pending);

  const keys = [...kv.store.keys()];
  assert.equal(keys.length, 1, `只该有一把按小时切的计数键，实际 ${keys.join(',')}`);
  assert.match(keys[0]!, /^ipfb:\d+$/);
  assert.equal(kv.store.get(keys[0]!), '2', '两次走兜底就该计到 2');
});

test('ipFallbackCount 读回来的是这一串键的和（健康页那个数字）', async () => {
  const kv = fakeKv();
  const pending: Promise<unknown>[] = [];
  const c = fakeCtx({}, kv, pending);
  /* 计数是「读-改-写」，并发跑会互相盖掉（这本来就是近似值，代码注释里也这么写），
     所以这里一次一次来，验的是「每来一次就 +1」而不是「并发下也准」。 */
  for (let i = 0; i < 3; i++) {
    clientIp(c);
    await flush(pending);
  }
  assert.equal(await ipFallbackCount({ CACHE: kv }), 3);
  assert.equal(await ipFallbackCount({}), 0, '没绑 CACHE 时不该炸，直接给 0');
});

test('CF_CLIENT_IP_FALLBACK 设了就按设的来（非 Cloudflare 部署的出口）', async () => {
  const kv = fakeKv();
  const pending: Promise<unknown>[] = [];
  const raw = new Headers();
  const c = {
    req: { raw: { headers: raw } },
    env: { CACHE: kv, CF_CLIENT_IP_FALLBACK: '198.51.100.7' },
    executionCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
  } as unknown as Context;
  assert.equal(clientIp(c), '198.51.100.7');
  await flush(pending);
  assert.equal(kv.store.size, 1, '换了兜底地址也一样要计数，否则健康页看不见');
});
