/**
 * media-variants.ts（CMS 侧）— 上传后自动生成三档变体，并维护构建期要读的清单
 *
 * 为什么要这份客户端胶水：变体必须在上传时用 canvas 现生成（Worker 没有图像处理能力），
 * 生成完还要把「母版键 → 三档地址 + 宽高比」写进内容仓的 data/media-variants.json，
 * Hugo 构建期才知道某张图该不该出 srcset。这两件事在「媒体页上传」与「文章编辑器插图」两处都要做，
 * 所以抽成一份，别两处各抄一遍。
 *
 * 失败策略：变体是加分项。任何一步失败都只 console.warn，**绝不让原图上传失败** ——
 * 清单里没有这一条时，主题会干净地回退到原图（不会 404，因为压根不出 srcset）。
 */
import { getApiBase } from './api';
import { prepareVariants } from './image-compress';

/** 母版键（uploads/日期/uuid.webp）→ 变体键（variants/uploads/日期/uuid/h720.webp） */
export function variantKeyFor(originKey: string, height: number): string {
  return `variants/${originKey.replace(/\.[^./]+$/, '')}/h${height}.webp`;
}

export interface VariantEntryPayload {
  a: number;
  v: Record<string, string>;
}

/**
 * 给刚上传的母版生成并上传三档，然后写清单。
 * 返回写进清单的那一条（回填 UI 也复用它）；失败返回 null。
 */
export type VariantOutcome =
  | { ok: true; entry: VariantEntryPayload }
  | { ok: false; reason: 'small' | 'error'; message: string };

export async function uploadVariants(file: File, originKey: string, bucketId?: string): Promise<VariantOutcome> {
  try {
    const prepared = await prepareVariants(file);
    /* 高度不到 360、动图、SVG：按设计不出变体，这**不是失败** */
    if (!prepared) return { ok: false, reason: 'small', message: '图片高度不足 360（或动图/矢量），按设计不做变体' };
    const v: Record<string, string> = {};
    for (const t of prepared.variants) {
      const fd = new FormData();
      fd.append('file', new File([t.blob], `h${t.height}.webp`, { type: 'image/webp' }));
      fd.append('key', variantKeyFor(originKey, t.height));
      if (bucketId) fd.append('bucket', bucketId);
      const qs = bucketId ? `?bucket=${encodeURIComponent(bucketId)}` : '';
      const res = await fetch(getApiBase() + '/api/admin/media/variant' + qs, { method: 'POST', credentials: 'include', body: fd });
      const d = (await res.json().catch(() => null)) as { data?: { url?: string }; message?: string } | null;
      if (!res.ok || !d?.data?.url) throw new Error(d?.message || `变体 h${t.height} 上传失败`);
      v[String(t.height)] = d.data.url;
    }
    if (!Object.keys(v).length) return { ok: false, reason: 'small', message: '没有可用的档位' };
    const m = await fetch(getApiBase() + '/api/admin/media-variants', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: originKey, entry: { a: prepared.aspect, v } }),
    });
    if (!m.ok) throw new Error((await m.text()).slice(0, 120) || '清单写入失败');
    return { ok: true, entry: { a: prepared.aspect, v } };
  } catch (e) {
    console.warn('[media-variants]', e);
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** 回填 UI 用：读一次清单（键 → { a, v }） */
export async function fetchVariantManifest(): Promise<Record<string, { a: number; v: Record<string, string> }>> {
  const res = await fetch(getApiBase() + '/api/admin/media-variants', { credentials: 'include' });
  const d = (await res.json().catch(() => null)) as { data?: { manifest?: Record<string, { a: number; v: Record<string, string> }> } } | null;
  return d?.data?.manifest ?? {};
}
