/**
 * 上传前的图片压缩：在浏览器里把位图重编码成 WebP，只上传 WebP（原图不上传）。
 *
 * · 为什么在浏览器做：Worker 免费档每次请求只有 10ms CPU，服务端转图会把整个 API 打死；
 *   而 Cloudflare Pages 的构建期图片管线只管站内图，上传进来的图是另一条路。
 * · 不动像素尺寸：宽高原样保留，省下来的全是编码的份，清晰度不受影响。
 * · GIF 原样上传（重编码会丢掉后面的帧，动图就变成一张静图）；SVG 是矢量，
 *   重绘反而糊，也原样走；其余位图（JPEG / PNG / BMP / AVIF…）转 WebP。
 * · 转完反而变大（本来就只有几 KB、或者已经高度优化过）就退回原文件，
 *   别把「压缩」做成变大。
 * · 任何一步失败都按原文件继续上传：压缩是加分项，不能把它变成上传失败的原因。
 */

export interface PreparedFile {
  /** 真正要上传的文件（转成功时是 .webp，其余情况就是原文件）
   */
  file: File;
  /** 选中的原始字节数 */
  from: number;
  /** 实际上传的字节数 */
  to: number;
  converted: boolean;
}

/** 矢量与动图不在压缩范围内 */
const SKIP = ['image/gif', 'image/svg+xml'];

/** 目视几乎无差别的档位：0.85 对照片截图都够用，再低就开始出现块状噪点 */
const QUALITY = 0.85;

export function fmtBytes(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

export async function prepareImage(file: File): Promise<PreparedFile> {
  const keep = (): PreparedFile => ({ file, from: file.size, to: file.size, converted: false });
  if (!file.type.startsWith('image/') || SKIP.includes(file.type)) return keep();
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return keep();

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.width || !canvas.height) return keep();
    ctx.drawImage(bitmap, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
    /* 不认 WebP 的浏览器会「成功」返回一张 PNG：直接改名成 .webp 存进桶里，
       地址与真实类型不符，主题的图片管线与阅读器都可能认不出这张图 */
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return keep();

    const name = (file.name.replace(/\.[^.]*$/, '') || 'image') + '.webp';
    return {
      file: new File([blob], name, { type: 'image/webp', lastModified: file.lastModified }),
      from: file.size,
      to: blob.size,
      converted: true,
    };
  } catch {
    return keep();
  } finally {
    /* ImageBitmap 占着解码后的显存，用完就放掉 */
    bitmap?.close?.();
  }
}

/** 上传气泡上那句话：转过的说省了多少，没转的说清为什么没转 */
export function compressNote(p: PreparedFile): string {
  if (!p.converted) return '';
  const saved = p.from > 0 ? Math.round((1 - p.to / p.from) * 100) : 0;
  return `${fmtBytes(p.from)} → ${fmtBytes(p.to)}，省了 ${saved}%`;
}
