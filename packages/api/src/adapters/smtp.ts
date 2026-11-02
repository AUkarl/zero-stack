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

/**
 * 多行应答以 "NNN " 结尾的那一行为最终响应。
 *
 * `untilMs` 是**整次发信的截止时间戳**：上一版这里没有任何时限，对端 TCP 连上了但不吐数据
 * （端口与加密方式配错、防火墙把包吃掉、服务商按 IP 掐线）时，`reader.read()` 会一直挂着 ——
 * 台架 2026-10-29 实测：同一封信，端口没人监听 2 秒就回 502，STARTTLS 档 95 秒不返回，
 * 前台的「订阅 / 找回密码 / 测试发信」跟着一起挂到 Workers 上限，用户什么提示都拿不到。
 */
async function readReply(socket: Socket, untilMs: number): Promise<string> {
  const reader = socket.readable.getReader();
  let buffer = '';
  try {
    for (;;) {
      const left = untilMs - Date.now();
      if (left <= 0) throw new Error(smtpTimeoutText);
      const raced = await Promise.race([
        reader.read(),
        new Promise<never>((_res, rej) => setTimeout(() => rej(new Error(smtpTimeoutText)), left)),
      ]);
      const { value, done } = raced;
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

/** 整次发信的时限（一次 SMTP 对话正常也就一两秒，超这个数就是对方不对劲，别把用户挂住） */
const SMTP_DEADLINE_MS = 12_000;
const smtpTimeoutText = `发信在 ${Math.round(SMTP_DEADLINE_MS / 1000)} 秒内没有完成：服务器连上了但不回话（多数是端口与加密方式不匹配 —— 465 要勾「隐式 TLS」，587/25 不勾；也可能是对方按 IP 掐线或中途丢包）。请在「设置 → 发信」按服务商文档核一遍端口与开关，再用本页「测试发信」复现`;

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
  const headers = [
    `From: ${from}`,
    `To: <${o.to}>`,
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
  /* 整次对话共用一个截止时间：任何一步（读应答、写命令、TLS 握手）超过它就整体失败，
     而不是让前台的「订阅 / 找回密码 / 测试发信」跟着挂到 Workers 上限（台架实测 STARTTLS
     档能挂 95 秒不返回）。上一版这些 await 一个都没有时限。 */
  const until = Date.now() + SMTP_DEADLINE_MS;
  const reply = (sock: Socket) => readReply(sock, until);
  const send = async (sock: Socket, text: string): Promise<void> => {
    const left = until - Date.now();
    if (left <= 0) throw new Error(smtpTimeoutText);
    await Promise.race([
      write(sock, text),
      new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(smtpTimeoutText)), left)),
    ]);
  };
  try {
    socket = connect(
      { hostname: o.host, port: o.port },
      { secureTransport: o.implicitTls ? 'on' : 'starttls', allowHalfOpen: false },
    );

    const greeting = await reply(socket);
    if (!greeting.startsWith('220')) return { success: false, error: `连接失败：${greeting || '服务器无应答'}` };

    let data: Socket = socket;
    const helo = `EHLO ${hostnameOf(o.from)}${EOL}`;
    if (!o.implicitTls) {
      await send(socket, helo);
      await reply(socket);
      await send(socket, `STARTTLS${EOL}`);
      const tls = await reply(socket);
      if (!tls.startsWith('220')) return { success: false, error: `STARTTLS 被拒绝：${tls}` };
      /* 不传 expectedServerHostname：workerd 不认识这个选项，传了只是打一行
         「NOSENTRY startTls called with unsupported expectedServerHostname option」把它静默丢掉，
         看起来像做了主机名校验、其实什么都没做（实测：插桩后 A/B 两条日志都打，说明调用本身没抛错，
         失败发生在其后的握手阶段）。证书链该不该信仍由运行时判断 —— 本地那台自签证书就是被拒的一方。
         想在这层再绑一次主机名，只能在拿到连接后自行比对，别指望这个选项。 */
      data = await Promise.race([Promise.resolve(socket.startTls()), new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(smtpTimeoutText)), Math.max(250, until - Date.now())))]);
    }
    await send(data, helo);
    await reply(data);

    await send(data, `AUTH LOGIN${EOL}`);
    const auth = await reply(data);
    if (!auth.startsWith('334')) return { success: false, error: `服务器不支持 AUTH LOGIN：${auth}` };

    await send(data, `${b64(o.user)}${EOL}`);
    const userReply = await reply(data);
    if (!userReply.startsWith('334')) return { success: false, error: `用户名被拒绝：${userReply}` };

    await send(data, `${b64(o.password)}${EOL}`);
    const passReply = await reply(data);
    if (!passReply.startsWith('235')) {
      return {
        success: false,
        error: `认证失败：${passReply}（QQ / 163 / 阿里等大多要求先开启 SMTP 并使用「授权码」而非登录密码）`,
      };
    }

    await send(data, `MAIL FROM:<${o.from}>${EOL}`);
    const fromReply = await reply(data);
    if (!fromReply.startsWith('250')) return { success: false, error: `发件人被拒绝：${fromReply}` };

    const rcptLines: string[] = [];
    await send(data, `RCPT TO:<${o.to}>${EOL}`);
    const toReply = await reply(data);
    rcptLines.push(toReply.trim());
    if (!toReply.startsWith('250') && !toReply.startsWith('251')) {
      return { success: false, error: `收件人被拒绝：${toReply}`, detail: rcptLines.join(' | ') };
    }

    await send(data, `DATA${EOL}`);
    const ready = await reply(data);
    if (!ready.startsWith('354')) return { success: false, error: `无法进入 DATA 阶段：${ready}`, detail: rcptLines.join(' | ') };

    await send(data, `${dotStuff(buildMessage(o))}${EOL}.${EOL}`);
    const sent = await reply(data);
    if (!sent.startsWith('250')) return { success: false, error: `投递失败：${sent}`, detail: rcptLines.join(' | ') };

    await send(data, `QUIT${EOL}`);
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
