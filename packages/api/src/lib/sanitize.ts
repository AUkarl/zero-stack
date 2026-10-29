/**
 * sanitize.ts — 用户填的文本进库前统一去控制字符。
 *
 * 为什么要有这一处：网址校验已经收成一个 `lib/httpUrl.ts`、长度收成一张表，但**控制字符**
 * （CR / LF / NUL / 零宽）一直没人口。实测 `POST /api/comments` 的 `name` 填
 * 「昵称\r\nX-Mailer: hacked」会原样入库并原样回显。后果分两档：
 *   · 走 SMTP 发信时主题会被整串 RFC 2047 编码（`adapters/smtp.ts` 的 `encodeHeader`），
 *     裸换行变不成新的一行信头 —— 台架抓真报文验过；
 *   · 但 `emailProvider=cloudflare` 那一档是用 `join('\r\n')` 手工拼 multipart 的，
 *     主题里的换行就是分段边界，理论上能多插一段（改掉那封信的正文）。
 * 与其记着「哪一档通道安全」，不如在入口一次洗干净：昵称、友链名与说明、作者笔名与简介、
 * 站点名与描述这类**单行字段**绝不该出现换行；正文类字段保留 `\n`，只把 `\r` 与其余控制字符去掉。
 */

/** 单行字段：去掉换行与其余控制字符、零宽字符，压掉首尾空白 */
export function cleanInline(value: unknown, max = 200): string {
  return stripControl(value, false).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 多行字段（评论正文、作者简介）：保留换行，CRLF/CR 统一成 LF，去掉其余控制字符 */
export function cleanMultiline(value: unknown, max = 5000): string {
  return stripControl(value, true).replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
}

/** 保留换行与否由调用方定；这里只管「把不该出现的字符拿掉」 */
function stripControl(value: unknown, keepNewline: boolean): string {
  let s = String(value ?? '');
  /* C0 控制字符（除 \t \n）与 DEL、C1 区、BOM、零宽，以及全部双向控制字符
     （‪-‮ 与 ⁦-⁩：这几个能把后面一串显示文字的顺序反过来，昵称里放一个就是 RTLO 伪装） */
  s = s.replace(
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    '',
  );
  /* 换行：保留就统一成 \n，不保留就连同 \r \t 一起去掉 */
  s = keepNewline ? s.replace(/\r\n?/g, '\n') : s.replace(/[\r\n\t]+/g, ' ');
  return s;
}

/** 邮件信头与收件人绝不能再有换行 —— 就算上游漏了清洗，这里也不让拼进 multipart */
export function assertNoHeaderBreaks(label: string, value: string): string | null {
  const s = String(value ?? '');
  if (/[\r\n]/.test(s)) return `${label}里含有换行（已拦下，没有发信）：这一项要写成一行`;
  return null;
}
