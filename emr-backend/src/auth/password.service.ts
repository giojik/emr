import { BadRequestException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

// OWASP-ის რეკომენდაცია argon2id-სთვის (~19 MiB, 2 იტერაცია)
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(plain: string) { return argon2.hash(plain, OPTIONS); }

  async verify(hash: string, plain: string) {
    try { return await argon2.verify(hash, plain); } catch { return false; }
  }

  needsRehash(hash: string) { return argon2.needsRehash(hash, OPTIONS); }

  /** არარსებულ მომხმარებელზეც იგივე დრო დაიხარჯოს — ანგარიშების "გამოცნობის" თავიდან ასაცილებლად */
  async dummyVerify(plain: string) {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(await this.dummyHash, plain);
  }

  assertPolicy(plain: string) {
    if (plain.length < PASSWORD_MIN || plain.length > PASSWORD_MAX) {
      throw new BadRequestException(`პაროლი უნდა იყოს ${PASSWORD_MIN}–${PASSWORD_MAX} სიმბოლო`);
    }
    if (!/[A-Za-z]/.test(plain) || !/\d/.test(plain)) {
      throw new BadRequestException('პაროლი უნდა შეიცავდეს მინიმუმ ერთ ასოს და ერთ ციფრს');
    }
  }

  /** დროებითი პაროლი ადმინისტრატორისთვის (ერთჯერადად ნაჩვენები) */
  static generateTemporary() {
    return `Tmp-${randomBytes(9).toString('base64url')}7`;
  }
}
