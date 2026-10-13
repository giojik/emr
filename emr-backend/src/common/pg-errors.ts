import { BadRequestException, ConflictException } from '@nestjs/common';

/** ტრიგერის შეცდომები (check_violation), რომლებიც HTTP 409-ია: constraint → კოდი */
export const PG_CONFLICTS: Record<string, string> = { period_locked: 'PERIOD_LOCKED', invoice_in_claim: 'INVOICE_IN_CLAIM',
  // 0054: ფასის / წესის პირდაპირი ცვლილება, როცა tariff_change_approval = required; ფინალიზებული ინვოისის ხაზი
  tariff_approval_required: 'TARIFF_APPROVAL_REQUIRED',
  // 0055: DRG ვერსიის შემადგენლობა — მხოლოდ მონახაზში
  drg_version_locked: 'DRG_VERSION_LOCKED' };

/** PostgreSQL-ის შეცდომების გადაყვანა გასაგებ HTTP პასუხებში. messages: constraint → ტექსტი */
export function mapPgError(e: unknown, messages: Record<string, string> = {}): never {
  const err = e as { code?: string; constraint?: string; message?: string };
  const byConstraint = err.constraint ? messages[err.constraint] : undefined;
  // 0053: დახურული ფინანსური პერიოდი / ქლეიმში შემავალი შემთხვევა — 409 (DB ტრიგერის ტექსტით)
  if (err.code === '23514' && err.constraint && PG_CONFLICTS[err.constraint]) {
    throw new ConflictException({ code: PG_CONFLICTS[err.constraint], message: err.message ?? 'კონფლიქტი' });
  }
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
