import { connect } from 'cloudflare:sockets';

/**
 * 极简 SMTP 客户端，直接跑在 Workers 的原生 TCP socket 上，
 * 所以"支持所有 SMTP 邮箱"是真实实现，不依赖第三方 HTTP 发信网关。
 *
 * 端口约定（实测 smtp.qiye.aliyun.com：465 用明文连过去 6 秒收不到一个字节，
 * 换 TLS 连过去立刻回 220 —— 465 只有隐式 TLS，别拿 STARTTLS 去试，白等一场后报「连接失败」）：
 *   465        → 连接即 TLS（secureTransport: 'on'）
 *   587 / 2525 → 明文连接后 STARTTLS 升级
 *   25         → Cloudflare 一律封死，不要尝试
 * 所以 465 一律走隐式 TLS；smtpSecure 只用来给「非 465 端口但服务端只收隐式 TLS」的自建环境留口子。
 */

export interface SmtpOptions {
  host: string;
  port: number;
  /** true = 465 隐式 TLS；false = 587 STARTTLS */
  implicitTls: boolean;
  user: string;
  password: string;
  from: string;
  fromName?: string;
  to: string;
  /** 抄送：抬头写 Cc，信封上也各投一次。为空时跟原来完全一样 */
  cc?: string[];
  subject: string;
  html: string;
  replyTo?: string;
}

const enc = new TextEncoder();
const EOL = '\r\n';

type Socket = ReturnType<typeof connect>;

async function write(socket: Socket, text: string): Promise<void> {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(enc.encode(text));
  } finally {
    writer.releaseLock();
  }
}

/** 多行应答以 "NNN " 结尾的那一行为最终响应 */
async function readReply(socket: Socket): Promise<string> {
  const reader = socket.readable.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += new TextDecoder().decode(value);
      const lines = buffer.split(EOL).filter((l) => l.length >= 4);
      const final = lines.filter((l) => /^\d{3} /.test(l)).pop();
      if (final) return final;
      if (done) return buffer.trim().split(EOL).pop() ?? '';
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 连接已关闭 */
    }
  }
}

function b64(s: string): string {
  const bytes = enc.encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 头部不允许裸换行，非 ASCII 主题按 RFC 2047 编码 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${b64(value)}?=`;
}

/** base64 正文按 76 列折行 */
function encodeBody(html: string): string {
  return b64(html).replace(/(.{76})/g, '$1' + EOL);
}

/** RFC 5321 点填充：以 . 开头的行前面再加一个 . */
function dotStuff(text: string): string {
  return text.replace(/^\./gm, '..');
}

function buildMessage(o: SmtpOptions): string {
  const from = o.fromName ? `${encodeHeader(o.fromName)} <${o.from}>` : `<${o.from}>`;
  const cc = envelopeOf(o);
  const headers = [
    `From: ${from}`,
    `To: <${o.to}>`,
    cc.length > 1 ? `Cc: ${cc.slice(1).map((x) => `<${x}>`).join(', ')}` : null,
    `Subject: ${encodeHeader(o.subject)}`,
    // Date 与 Message-ID 是 RFC 5322 必需的两项。以前没发：收件方反垃圾（QQ / 163 / Gmail）
    // 缺了 Message-ID 就没法做去重与串会话，容易被判成垃圾；缺 Date 的邮件在有些客户端排在最后。
    `Date: ${rfc2822Date(new Date())}`,
    `Message-ID: ${messageId(o.from)}`,
    o.replyTo ? `Reply-To: <${o.replyTo}>` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  return headers.join(EOL) + EOL + EOL + encodeBody(o.html);
}

/** toUTCString 出来的就是 RFC 2822 那种「Wed, 07 Oct 2026 12:00:00 GMT」 */
function rfc2822Date(d: Date): string {
  return d.toUTCString();
}

/** 主机名取发件地址的域名，左边是「时间戳.随机」—— 同一封信重投时 Message-ID 不变才算得上一封 */
function messageId(from: string): string {
  const host = from.split('@')[1] ?? 'localhost';
  const rand = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '');
  return `<${Date.now().toString(36)}.${rand}@${host}>`;
}

/** 信封收件人：主收 + 抄送，去掉重复与空串（抄送自己时不该多收一封） */
function envelopeOf(o: SmtpOptions): string[] {
  const out: string[] = [];
  for (const x of [o.to, ...(o.cc ?? [])]) {
    const e = (x ?? '').trim().toLowerCase();
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

export interface SmtpResult {
  success: boolean;
  error?: string;
  /**
   * 服务器原文回执（RCPT 各条应答 + DATA 结尾那行 250）。
   * 「库里写着 sent 但邮箱里没有」只能靠它判断：中继回 250 只代表它收下了这封信，
   * 真正投没投进对方邮箱、有没有进垃圾箱，要再看服务商的投递日志。
   */
  detail?: string;
}

function hostnameOf(email: string): string {
  return email.split('@')[1] ?? 'localhost';
}

export async function sendViaSmtp(o: SmtpOptions): Promise<SmtpResult> {
  let socket: Socket | null = null;
  try {
    socket = connect(
      { hostname: o.host, port: o.port },
      { secureTransport: o.implicitTls ? 'on' : 'starttls', allowHalfOpen: false },
    );

    const greeting = await readReply(socket);
    if (!greeting.startsWith('220')) return { success: false, error: `连接失败：${greeting || '服务器无应答'}` };

    let data: Socket = socket;
    const helo = `EHLO ${hostnameOf(o.from)}${EOL}`;
    if (!o.implicitTls) {
      await write(socket, helo);
      await readReply(socket);
      await write(socket, `STARTTLS${EOL}`);
      const tls = await readReply(socket);
      if (!tls.startsWith('220')) return { success: false, error: `STARTTLS 被拒绝：${tls}` };
      data = socket.startTls({ expectedServerHostname: o.host });
    }
    await write(data, helo);
    await readReply(data);

    await write(data, `AUTH LOGIN${EOL}`);
    const auth = await readReply(data);
    if (!auth.startsWith('334')) return { success: false, error: `服务器不支持 AUTH LOGIN：${auth}` };

    await write(data, `${b64(o.user)}${EOL}`);
    const userReply = await readReply(data);
    if (!userReply.startsWith('334')) return { success: false, error: `用户名被拒绝：${userReply}` };

    await write(data, `${b64(o.password)}${EOL}`);
    const passReply = await readReply(data);
    if (!passReply.startsWith('235')) {
      return {
        success: false,
        error: `认证失败：${passReply}（QQ / 163 / 阿里等大多要求先开启 SMTP 并使用「授权码」而非登录密码）`,
      };
    }

    await write(data, `MAIL FROM:<${o.from}>${EOL}`);
    const fromReply = await readReply(data);
    if (!fromReply.startsWith('250')) return { success: false, error: `发件人被拒绝：${fromReply}` };

    const rcptLines: string[] = [];
    for (const one of envelopeOf(o)) {
      await write(data, `RCPT TO:<${one}>${EOL}`);
      const toReply = await readReply(data);
      rcptLines.push(toReply.trim());
      if (!toReply.startsWith('250') && !toReply.startsWith('251')) {
        return { success: false, error: `收件人被拒绝：${toReply}`, detail: rcptLines.join(' | ') };
      }
    }

    await write(data, `DATA${EOL}`);
    const ready = await readReply(data);
    if (!ready.startsWith('354')) return { success: false, error: `无法进入 DATA 阶段：${ready}`, detail: rcptLines.join(' | ') };

    await write(data, `${dotStuff(buildMessage(o))}${EOL}.${EOL}`);
    const sent = await readReply(data);
    if (!sent.startsWith('250')) return { success: false, error: `投递失败：${sent}`, detail: rcptLines.join(' | ') };

    await write(data, `QUIT${EOL}`);
    safeClose(data);
    return { success: true, detail: [...rcptLines, sent.trim()].join(' | ') };
  } catch (e) {
    if (socket) safeClose(socket);
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function safeClose(s: Socket): void {
  try {
    s.close();
  } catch {
    /* 已关闭 */
  }
}
