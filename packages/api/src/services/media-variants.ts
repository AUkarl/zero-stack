/**
 * media-variants.ts — 图片「三档变体」的键规则与清单（R44）
 *
 * 为什么清单放在**内容仓**（data/media-variants.json）而不是 D1：
 *   真正要用这份数据的是 Hugo —— 构建期要决定某张图有没有 360/720/1080 变体、要不要出 srcset。
 *   Hugo 构建时连不到 D1，只能读仓库里的 data/*.json；而 CMS 本来就在往这个仓库提交内容，
 *   上传完顺手更新这一份是最短的路径（也便于在仓库里直接审计「哪些图还没回填」）。
 *
 * 清单形状（键是**去掉桶前缀的显示键**，与媒体库列表一致）：
 *   {
 *     "uploads/2026-10-23/<uuid>.webp": { "a": 1.5, "v": { "360": "https://…/h360.webp", "720": "…", "1080": "…" } }
 *   }
 *   a = 宽/高（构建期据此算 width/height，避免 CLS）；v 里缺哪档就是没生成。
 *
 * 变体键规则：variants/<母版键去掉扩展名>/h<高度>.webp
 *   放在 variants/ 前缀下是刻意的：后台媒体库固定列 uploads/，所以选择器里不会冒出这些文件。
 */
import { readRepoFile, writeRepoFile } from './repo';
import { getConfig } from './config';
import type { MediaBucket } from './media';
import { deleteMediaObject, listMediaObjects } from './media';

/** 三档：显示用 360/720，点开放大用 1080 */
export const VARIANT_HEIGHTS = [360, 720, 1080] as const;
export type VariantHeight = (typeof VARIANT_HEIGHTS)[number];

export interface VariantEntry {
  /** 宽/高 */
  a: number;
  v: Partial<Record<'360' | '720' | '1080', string>>;
}
export type VariantManifest = Record<string, VariantEntry>;

const VARIANT_ROOT = 'variants/';

export function isVariantKey(key: string): boolean {
  return key.startsWith(VARIANT_ROOT);
}

/** 母版键 → 变体目录（去掉扩展名） */
export function variantDir(key: string): string {
  return `${VARIANT_ROOT}${key.replace(/\.[^./]+$/, '')}/`;
}

export function variantKey(key: string, height: number): string {
  return `${variantDir(key)}h${height}.webp`;
}

export function isValidOriginKey(key: string): boolean {
  return /^uploads\/[A-Za-z0-9._/-]+$/.test(key) && !key.includes('..');
}

export function isValidVariantObjectKey(key: string): boolean {
  return /^variants\/[A-Za-z0-9._/-]+\.webp$/.test(key) && !key.includes('..');
}

async function manifestPath(env: Env): Promise<string> {
  const dir = ((await getConfig(env, 'githubDataDir')) || 'data').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return `${dir}/media-variants.json`;
}

export async function readVariantsManifest(env: Env): Promise<VariantManifest> {
  const file = await readRepoFile(env, await manifestPath(env)).catch(() => null);
  if (!file?.content) return {};
  try {
    const parsed = JSON.parse(file.content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as VariantManifest;
  } catch {
    /* 清单坏掉不该让上传失败：当作空清单，下一次上传会把新条目写进去 */
    return {};
  }
}

/**
 * 合并一条（上传完成 / 回填时调用）。读-改-写带乐观锁：GitHub 那边并发提交会 409，
 * 遇到冲突重读一次再写，最多两次 —— 比让用户看到「上传成功但清单没更新」好。
 */
export async function mergeVariantEntry(env: Env, originKey: string, entry: VariantEntry): Promise<VariantManifest> {
  const path = await manifestPath(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await readRepoFile(env, path).catch(() => null);
    let manifest: VariantManifest = {};
    if (file?.content) {
      try {
        const parsed = JSON.parse(file.content) as VariantManifest;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed;
      } catch {
        manifest = {};
      }
    }
    manifest[originKey] = entry;
    const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
    const res = await writeRepoFile(env, path, JSON.stringify(sorted, null, 2) + '\n', `media: variants for ${originKey}`);
    if (res.success || !/conflict|冲突/i.test(String(res.error ?? ''))) return sorted;
  }
  /* 两次都没成：返回内存里这份，让调用方至少能继续把图传完；清单缺失的后果是构建期回退原图 */
  const fresh = await readVariantsManifest(env);
  return fresh;
}

export async function removeVariantEntry(env: Env, originKey: string): Promise<void> {
  const path = await manifestPath(env);
  const file = await readRepoFile(env, path).catch(() => null);
  if (!file?.content) return;
  let manifest: VariantManifest;
  try {
    manifest = JSON.parse(file.content) as VariantManifest;
  } catch {
    return;
  }
  if (!(originKey in manifest)) return;
  delete manifest[originKey];
  await writeRepoFile(env, path, JSON.stringify(manifest, null, 2) + '\n', `media: drop variants of ${originKey}`);
}

/**
 * 删母版时把它的三个变体一起删掉（否则桶里会留一堆没人引用的孤儿）。
 * 失败不抛：删除母版这件事已经完成，变体删不掉最多是多几个对象。
 */
export async function deleteVariantsOf(env: Env, bucket: MediaBucket, originKey: string): Promise<number> {
  const prefix = variantDir(originKey);
  let deleted = 0;
  try {
    const listed = await listMediaObjects(env, bucket, { prefix, limit: 50 });
    for (const o of listed.objects) {
      try {
        await deleteMediaObject(env, bucket, o.key);
        deleted++;
      } catch {
        /* 单个失败继续 */
      }
    }
  } catch {
    /* 列不出来就当没有 */
  }
  return deleted;
}
