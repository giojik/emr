import { type ArgumentsHost, Catch, ConflictException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { PG_CONFLICTS } from './pg-errors';

/**
 * 0053: DB ტრიგერის შეცდომა, რომელიც სერვისმა არ გადაიყვანა (period_locked — დახურული ფინანსური პერიოდი, invoice_in_claim) → 409.
 * დანარჩენი — Nest-ის სტანდარტული დამუშავება.
 */
@Catch()
export class PgLockFilter extends BaseExceptionFilter {
  override catch(e: unknown, host: ArgumentsHost) {
    const err = e as { code?: string; constraint?: string; message?: string };
    if (err?.code === '23514' && err.constraint && PG_CONFLICTS[err.constraint]) {
      return super.catch(new ConflictException({ code: PG_CONFLICTS[err.constraint], message: err.message }), host);
    }
    return super.catch(e, host);
  }
}
