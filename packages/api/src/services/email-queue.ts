import { sendEmail } from './email';

/**
 * 队列消费者。批内逐条发送并各自记账，失败不整批 reject——
 * 否则一个坏邮箱会让整批邮件反复重投。
 *
 * 记账已由 queueEmail 在入队时写下那一行（status=queued），这里只把 job 里的 logId 带回
 * 给 sendEmail 就地更新成 sent / failed + 服务器原文；没有 logId 的老消息（部署前就已在
 * 队列里飞的）由 sendEmail 自己补一行，不会丢记录。
 */
export async function handleEmailBatch(batch: MessageBatch<EmailJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    // 走 sendEmail 而不是直接 sendBySmtp：它按 emailProvider 分流，
    // 设置里选了 Resend / Cloudflare Email 时这条队列才不会绕过用户选的通道硬发 SMTP
    const result = await sendEmail(env, {
      to: job.to,
      subject: job.subject,
      html: job.html,
      from: job.from,
      kind: job.kind,
      postId: job.postId,
      logId: job.logId,
    });
    // 网络类错误重投，配置类错误重投也不会成功，直接 ack
    if (!result.success && /timeout|reset|connection|ECONN/i.test(result.error ?? '')) message.retry();
    else message.ack();
  }
}
