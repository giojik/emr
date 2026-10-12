import { Controller, Get, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { NotificationsModule } from '../notifications/notifications';
import { FinClaimsController, FinClaimsService } from './finance-claims';
import { FinCommon } from './finance-common';
import { FinPeriodsController, FinPeriodsService } from './finance-periods';
import { FinReportsController, FinReportsService } from './finance-reports';
import { FIN_FULL, FIN_READ } from './finance-rules';

/** ჩანართების ბეჯები / სათაური: დებიტორები (ვადაგადაცილებული ქლეიმი), period_lock, ბოლო დახურული თვე */
@Controller('finance')
export class FinSummaryController {
  constructor(private readonly c: FinCommon, private readonly claims: FinClaimsService) {}
  @Get('summary') @Roles(...FIN_READ, 'billing')
  async summary(@CurrentUser() u: AuthUser) {
    const rules = await this.c.rules();
    const scope = has(u, ...FIN_READ) ? await this.c.scope(u, rules) : { dept: null, dept_name: null };   // billing — მხოლოდ ქლეიმები
    const last = await this.c.db.selectFrom('fin_periods').select('month').where('status', '=', 'closed').orderBy('month', 'desc').limit(1).executeTakeFirst();
    return { period_lock: rules.period_lock, last_closed: last ? String(last.month).slice(0, 7) : null, scope_department: scope.dept_name,
      full: has(u, ...FIN_FULL), claims: has(u, ...FIN_FULL, 'billing') ? await this.claims.summary() : null, rules: { revenue_basis: rules.revenue_basis,
        revenue_dept_basis: rules.revenue_dept_basis, dept_consumption_basis: rules.dept_consumption_basis, overhead_allocation: rules.overhead_allocation } };
  }
}

/** ფინანსები (0053): შემოსავალი, მარაგი / მოხმარება, განყოფილების შედეგი, გადამხდელის დებიტორები (ქლეიმები), პერიოდის დახურვა */
@Module({
  imports: [NotificationsModule, AuthModule],
  controllers: [FinSummaryController, FinReportsController, FinClaimsController, FinPeriodsController],
  providers: [FinCommon, FinReportsService, FinClaimsService, FinPeriodsService],
})
export class FinanceModule {}
