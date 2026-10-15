import { eq } from 'drizzle-orm';
import { emailLogs } from '../db/schema';
import { createDb } from '../db/client';
import { sendBySmtp } from './email';
import { newId } from '../lib/crypto';

/**
 * 队列消费者。批内逐条发送并各自记账，失败不整批 reject——
 * 否则一个坏邮箱会让整批邮件反复重投。
 */
export async function handleEmailBatch(batch: MessageBatch<EmailJob>, env: Env): Promise<void> {
  const db = createDb(env);
  for (const message of batch.messages) {
    const job = message.body;
    const id = newId();
    await db.insert(emailLogs).values({
      id,
      to: job.to,
      subject: job.subject,
      status: 'queued',
      postId: job.postId ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    });

    const result = await sendBySmtp(env, { to: job.to, subject: job.subject, html: job.html, from: job.from, kind: job.kind });
    if (result.success) {
      await db.update(emailLogs).set({ status: 'sent', sentAt: Math.floor(Date.now() / 1000) }).where(eq(emailLogs.id, id));
      continue;
    }

    await db.update(emailLogs).set({ status: 'failed', error: result.error ?? '未知原因' }).where(eq(emailLogs.id, id));
    // 网络类错误重投，配置类错误重投也不会成功，直接 ack
    if (/timeout|reset|connection|ECONN/i.test(result.error ?? '')) message.retry();
    else message.ack();
  }
}
