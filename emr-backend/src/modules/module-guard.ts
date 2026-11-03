import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ModulesService } from './modules';

export const MODULE_KEY = 'emr:module';
export const HISTORY_KEY = 'emr:clinicalHistory';
export const READ_SAFE_KEY = 'emr:readOnlySafe';
export const PORT_KEY = 'emr:modulePort';

/**
 * მოდულის მოთხოვნა (0085): controller-ზე ან მეთოდზე (მეთოდი უპირატესია). რამდენიმე კოდი — „რომელიმე“ აქტიური.
 * ყველა controller-ს უნდა ჰქონდეს (გაშვებისას მოწმდება). ბირთვი — 'core' / 'mpi' / 'encounters' / 'billing'.
 */
export const RequireModule = (...codes: [string, ...string[]]) => SetMetadata(MODULE_KEY, codes);
/** პაციენტის კლინიკური ისტორიის წაკითხვა: გამორთულ / ლიცენზიის გარეშე მოდულზეც (GET) — კლინიკური მონაცემი არ იმალება */
export const ClinicalHistory = () => SetMetadata(HISTORY_KEY, true);
/**
 * რბილი კავშირის „პორტი“: endpoint-ს სხვა მოდულები / ეკრანები იძახებენ და ის თავად აბრუნებს ნეიტრალურ პასუხს, როცა მოდული არააქტიურია
 * (მაგ. `{enabled: false}`, ცარიელი სია, mode = off). guard მას არ ბლოკავს.
 */
export const ModulePort = () => SetMetadata(PORT_KEY, true);
/** POST, რომელიც მხოლოდ კითხულობს (ძებნა, ბეჭდვა, ექსპორტი, preview) — ლიცენზიის ვადის შემდეგ („მხოლოდ წაკითხვა“) დაშვებულია */
export const ReadOnlySafe = () => SetMetadata(READ_SAFE_KEY, true);

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * გლობალური guard: active — ყველაფერი; read_only (ლიცენზიის ვადა) — GET / @ReadOnlySafe; გამორთული / ლიცენზიის გარეშე /
 * წინაპირობის გარეშე — მხოლოდ @ClinicalHistory GET; სხვა — 403 (MODULE_DISABLED / MODULE_NOT_LICENSED / LICENSE_EXPIRED).
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  private svc?: ModulesService;
  constructor(private readonly reflector: Reflector, private readonly ref: ModuleRef) {}

  private modules(): ModulesService {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.svc ??= this.ref.get(require('./modules').ModulesService, { strict: false });
    return this.svc as ModulesService;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const codes = this.reflector.getAllAndOverride<string[] | undefined>(MODULE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!codes?.length) return true;
    if (this.reflector.get<boolean>(PORT_KEY, ctx.getHandler())) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const read = READ_METHODS.includes(req.method) || !!this.reflector.get<boolean>(READ_SAFE_KEY, ctx.getHandler());
    const history = !!this.reflector.get<boolean>(HISTORY_KEY, ctx.getHandler());
    const svc = this.modules();
    let first: Error | null = null;
    for (const c of codes) {
      const st = await svc.state(c).catch(() => null);
      if (!st) continue;
      if (st.state === 'active') return true;
      if (st.state === 'read_only' && read) return true;
      if (history && read) return true;
      first ??= await svc.denial(c, !read);
    }
    if (first) throw first;
    return true;
  }
}
