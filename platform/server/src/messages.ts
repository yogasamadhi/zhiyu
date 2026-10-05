import { createHmac, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Config } from './config.js';
// Actual sending is opt-in. Credentials are environment references, never browser fields.
export async function deliver(config: Config, target: string, code: string) {
  if (config.CLOUD_REAL_MESSAGES !== 'true') throw new Error('Real delivery disabled');
  if (target.includes('@')) {
    const url = process.env.CLOUD_SMTP_URL;
    const from = process.env.CLOUD_MAIL_FROM;
    if (!url || !from) throw new Error('SMTP is not configured');
    const transport = nodemailer.createTransport(url, {
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    await transport.sendMail({
      from,
      to: target,
      subject: '织云账户验证码',
      text: `验证码：${code}，10 分钟内有效。请勿向他人透露。`,
    });
    return;
  }
  const accessKey = process.env.CLOUD_ALIYUN_ACCESS_KEY_ID;
  const accessSecret = process.env.CLOUD_ALIYUN_ACCESS_KEY_SECRET;
  const signName = process.env.CLOUD_ALIYUN_SMS_SIGN;
  const template = process.env.CLOUD_ALIYUN_SMS_TEMPLATE;
  if (!accessKey || !accessSecret || !signName || !template)
    throw new Error('Aliyun SMS is not configured');
  const params: Record<string, string> = {
    Action: 'SendSms',
    Version: '2017-05-25',
    RegionId: 'cn-hangzhou',
    Format: 'JSON',
    AccessKeyId: accessKey,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    PhoneNumbers: target.replace(/^\+86/, ''),
    SignName: signName,
    TemplateCode: template,
    TemplateParam: JSON.stringify({ code }),
  };
  const encode = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k]!)}`)
    .join('&');
  params.Signature = createHmac('sha1', `${accessSecret}&`)
    .update(`POST&%2F&${encode(canonical)}`)
    .digest('base64');
  const response = await fetch('https://dysmsapi.aliyuncs.com/', {
    method: 'POST',
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10000),
  });
  const result = (await response.json()) as { Code?: string };
  if (!response.ok || result.Code !== 'OK') throw new Error('SMS delivery failed');
}
