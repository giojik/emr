import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { loadEnv } from '../config/env';

export interface NotifyResult { sent: string[]; errors: string[] }

/**
 * შეტყობინებები თანამშრომლებს (არა პაციენტებს): ელ-ფოსტა (SMTP) და SMS (HTTP სერვისი).
 *  SMS: POST SMS_API_URL, JSON {to, text}, Authorization: Bearer SMS_API_TOKEN — ორგანიზაციის SMS მიკროსერვისი.
 *  კონფიგურაციის გარეშე შეცდომას არ აგდებს — აბრუნებს „არ არის კონფიგურირებული“.
 */
@Injectable()
export class NotifyService {
  private readonly env = loadEnv();
  private readonly log = new Logger('Notify');
  private transport = this.env.SMTP_HOST ? nodemailer.createTransport({
    host: this.env.SMTP_HOST, port: this.env.SMTP_PORT, secure: this.env.SMTP_SECURE,
    auth: this.env.SMTP_USER ? { user: this.env.SMTP_USER, pass: this.env.SMTP_PASS ?? '' } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  }) : null;

  configured() { return { email: !!this.transport, sms: !!this.env.SMS_API_URL }; }

  async email(to: string[], subject: string, text: string): Promise<NotifyResult> {
    const r: NotifyResult = { sent: [], errors: [] };
    if (!to.length) return r;
    if (!this.transport) { r.errors.push('ელ-ფოსტა არ არის კონფიგურირებული (SMTP_HOST)'); return r; }
    try {
      await this.transport.sendMail({ from: this.env.SMTP_FROM || this.env.SMTP_USER, to: to.join(', '), subject, text });
      r.sent.push(...to);
    } catch (e) { r.errors.push(`ელ-ფოსტა: ${(e as Error).message}`); this.log.warn((e as Error).message); }
    return r;
  }

  async sms(phones: string[], text: string): Promise<NotifyResult> {
    const r: NotifyResult = { sent: [], errors: [] };
    if (!phones.length) return r;
    if (!this.env.SMS_API_URL) { r.errors.push('SMS არ არის კონფიგურირებული (SMS_API_URL)'); return r; }
    for (const to of phones) {
      try {
        const res = await fetch(this.env.SMS_API_URL, {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', ...(this.env.SMS_API_TOKEN ? { authorization: `Bearer ${this.env.SMS_API_TOKEN}` } : {}) },
          body: JSON.stringify({ to, text }),
        });
        if (res.ok) r.sent.push(to); else r.errors.push(`SMS ${to}: HTTP ${res.status}`);
      } catch (e) { r.errors.push(`SMS ${to}: ${(e as Error).message}`); }
    }
    return r;
  }
}

@Global()
@Module({ providers: [NotifyService], exports: [NotifyService] })
export class NotifyModule {}
