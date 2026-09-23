import { Global, Injectable, Logger, Module, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Client } from 'minio';
import type { Readable } from 'node:stream';
import { loadEnv } from '../config/env';

/** S3-თავსებადი ფაილსაცავი (MinIO / ნებისმიერი S3) — ვენდორის ჩანაცვლება კოდის ცვლილების გარეშე */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger('Storage');
  private readonly env = loadEnv();
  private readonly client: Client;
  readonly bucket = this.env.S3_BUCKET;

  constructor() {
    const u = new URL(this.env.S3_ENDPOINT);
    this.client = new Client({
      endPoint: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), useSSL: u.protocol === 'https:',
      accessKey: this.env.S3_ACCESS_KEY, secretKey: this.env.S3_SECRET_KEY, region: this.env.S3_REGION, pathStyle: true,
    });
  }

  private ready = false;

  async onModuleInit() {
    try { await this.ensureBucket(); } catch (e) {
      // საცავის მიუწვდომლობა API-ს გაშვებას არ აჩერებს — მხოლოდ დოკუმენტების ფუნქციები ჩავარდება (503)
      this.log.error(`ფაილსაცავი მიუწვდომელია (${this.env.S3_ENDPOINT}): ${(e as Error).message}`);
    }
  }

  private async ensureBucket() {
    if (this.ready) return;
    if (!(await this.client.bucketExists(this.bucket))) {
      await this.client.makeBucket(this.bucket, this.env.S3_REGION);
      this.log.log(`bucket შეიქმნა: ${this.bucket}`);
    }
    this.ready = true;
  }

  private unavailable(e: unknown): never {
    this.log.error(`ფაილსაცავის შეცდომა: ${(e as Error).message}`);
    throw new ServiceUnavailableException('ფაილსაცავი (MinIO) მიუწვდომელია — მიმართეთ IT-ს');
  }

  async put(key: string, data: Buffer, contentType: string) {
    try {
      await this.ensureBucket();
      await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': contentType });
      return key;
    } catch (e) { this.ready = false; this.unavailable(e); }
  }

  async get(key: string): Promise<Readable> {
    try { return await this.client.getObject(this.bucket, key); } catch (e) { this.unavailable(e); }
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
