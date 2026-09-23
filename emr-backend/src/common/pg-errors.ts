import { BadRequestException, ConflictException } from '@nestjs/common';

/** PostgreSQL-ის შეცდომების გადაყვანა გასაგებ HTTP პასუხებში. messages: constraint → ტექსტი */
export function mapPgError(e: unknown, messages: Record<string, string> = {}): never {
  const err = e as { code?: string; constraint?: string; message?: string };
  const byConstraint = err.constraint ? messages[err.constraint] : undefined;
  switch (err.code) {
    case '23505': throw new ConflictException(byConstraint ?? 'ჩანაწერი უკვე არსებობს');
    case '23P01': throw new ConflictException(byConstraint ?? 'დროის გადაფარვა სხვა ჩანაწერთან');
    case '23503': throw new BadRequestException(byConstraint ?? 'მითითებული დაკავშირებული ჩანაწერი არ არსებობს');
    case '23514': throw new BadRequestException(byConstraint ?? err.message ?? 'მონაცემები არ აკმაყოფილებს წესს');
    default: throw e;
  }
}

export async function withPgErrors<T>(fn: () => Promise<T>, messages?: Record<string, string>): Promise<T> {
  try { return await fn(); } catch (e) { mapPgError(e, messages); }
}
