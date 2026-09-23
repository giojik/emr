import type { Request } from 'express';
import type { AuthUser } from '../auth/roles';
import type { AuditContext } from './audit.service';

/** აუდიტის კონტექსტი HTTP მოთხოვნიდან: მომხმარებელი (JWT) + IP + user-agent */
export const auditCtx = (req: Request): AuditContext => ({
  userId: (req as Request & { user?: AuthUser }).user?.id ?? null,
  ip: req.ip,
  userAgent: req.get('user-agent'),
});
