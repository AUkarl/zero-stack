import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/** 每个请求按 env.DB 建一次，Drizzle 的 D1 driver 本身没有连接开销 */
export function createDb(env: Env) {
  return drizzle(env.DB, { schema, logger: false });
}
