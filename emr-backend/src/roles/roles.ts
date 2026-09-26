import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { invalidateAllUserStatus } from '../auth/auth.guard';
import { Roles } from '../auth/decorators';
import { CAPABILITIES, type Capability } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { UsersModule, UsersService } from '../users/users.module';

/** უფლებების კატალოგი: ჯგუფი, დასახელება, რას აძლევს (ადმინისტრირების ეკრანისთვის) */
export const CAPABILITY_INFO: Record<Capability, { group: string; name: string; grants: string }> = {
  admin: { group: 'ადმინისტრირება', name: 'ადმინისტრატორი', grants: 'სრული წვდომა ყველა მოდულზე, მომხმარებლები, როლები, კლინიკის პარამეტრები, აუდიტი' },
  receptionist: { group: 'ამბულატორია', name: 'რეგისტრატურა', grants: 'პაციენტები, ჩაწერა, check-in, ვიზიტი ექიმის გარეშე, დიაგნოსტიკის განრიგი, სალარო (მიღება)' },
  billing: { group: 'ამბულატორია', name: 'სალარო / ფინანსები', grants: 'გადახდები, ფასდაკლება, ტარიფები და კვლევების ფასები' },
  doctor: { group: 'კლინიკური', name: 'ექიმი', grants: 'ვიზიტი (მკურნალ ექიმად), დიაგნოზები, დანიშნულება, კვლევების შეკვეთა, ფორმა 100' },
  nurse: { group: 'კლინიკური', name: 'ექთანი', grants: 'ვიზიტები: ვიტალები, ალერგიები; ნიმუშის აღება' },
  pharmacist: { group: 'კლინიკური', name: 'ფარმაცევტი', grants: 'ალერგენული ჯგუფები, override-ების რეპორტი' },
  phlebotomist: { group: 'ლაბორატორია', name: 'ფლებოტომია', grants: 'მხოლოდ ნიმუშის აღება და სინჯარის ეტიკეტები' },
  diagnostic: { group: 'ლაბორატორია', name: 'ლაბორანტი', grants: 'სინჯარის მიღება, შედეგების შეტანა, სხვა მიმართვები' },
  lab_doctor: { group: 'ლაბორატორია', name: 'ლაბ. ექიმი / ხელმძღვანელი', grants: 'შედეგების ვალიდაცია და შესწორება, ნორმების დამტკიცება, ანალიზების ფორმები' },
  lab_manager: { group: 'ლაბორატორია', name: 'ლაბ. მენეჯერი', grants: 'ანალიზების ფორმები და კატალოგი (ვალიდაციის გარეშე)' },
  radiographer: { group: 'რადიოლოგია', name: 'რენტგენ-ტექნიკოსი', grants: 'განრიგი, პაციენტის მიღება, კვლევის შესრულება (კონტრასტი, დოზა, უსაფრთხოება), სურათები' },
  radiologist: { group: 'რადიოლოგია', name: 'რადიოლოგი', grants: 'რადიოლოგიის დასკვნა, ხელმოწერა, შაბლონები' },
  endoscopy_nurse: { group: 'ენდოსკოპია', name: 'ენდოსკოპიის ექთანი', grants: 'განრიგი, ჩეკლისტი, სედაცია, ენდოსკოპები და დეზინფექცია, ბიოფსიის გაგზავნა/პასუხი' },
  endoscopist: { group: 'ენდოსკოპია', name: 'ენდოსკოპისტი', grants: 'ენდოსკოპიის ოქმი, სურათები, მანიპულაციები, ბიოფსია, ხელმოწერა, შაბლონები' },
  hr: { group: 'მართვა', name: 'პერსონალი (HR)', grants: 'მომხმარებლების დამატება/გათიშვა/პაროლის აღდგენა, როლების მინიჭება — ადმინისტრატორის უფლების მქონეების გარდა' },
  manager: { group: 'მართვა', name: 'მენეჯერი', grants: 'დღის დაფა, ჩაწერა/check-in, დიაგნოსტიკის განრიგი, აქტივობის რეპორტი, საკუთარი განყოფილების თანამშრომლები (განბლოკვა, პაროლი, გათიშვა)' },
  accountant: { group: 'მართვა', name: 'ბუღალტერი', grants: 'ფინანსური რეპორტები (შემოსავალი, გადახდები, ფასდაკლებები, დავალიანება), ხარჯების ჟურნალი, ექსპორტი' },
  viewer: { group: 'მართვა', name: 'ხელმძღვანელობა (ნახვა)', grants: 'ყველა რეპორტი, დღის დაფა და დიაგნოსტიკის განრიგი — მხოლოდ ნახვა, ცვლილების გარეშე' },
  med_engineer: { group: 'მართვა', name: 'სამედიცინო ინჟინერი', grants: 'აპარატები და ოთახები, ენდოსკოპების რეესტრი (დამატება, რედაქტირება, ისტორია)' },
};

const CODE = /^[a-z][a-z0-9_]{1,39}$/;
class CreateRoleDto {
  @Matches(CODE, { message: 'კოდი: ლათინური პატარა ასოები, ციფრები, _ (მაგ. doctor_endo)' }) code: string;
  @IsString() @Length(2, 100) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  /** ცარიელი = პოზიცია უფლებების გარეშე (მძღოლი, სანიტარი, HR…) — სისტემაში წვდომას არ იძლევა */
  @IsArray() @IsIn(CAPABILITIES, { each: true }) capabilities: Capability[];
  @IsOptional() @IsInt() sort_order?: number;
}
class UpdateRoleDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsArray() @IsIn(CAPABILITIES, { each: true }) capabilities?: Capability[];
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}

@Injectable()
export class RolesService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly users: UsersService) {}

  list(includeInactive = true) {
    let q = this.db.selectFrom('roles as r')
      .selectAll('r')
      .select([
        sql<number>`(SELECT count(*)::int FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.is_active)`.as('active_users'),
        sql<number>`(SELECT count(*)::int FROM users u WHERE u.role = r.code)`.as('primary_users'),
      ]).orderBy('r.sort_order').orderBy('r.name');
    if (!includeInactive) q = q.where('r.is_active', '=', true);
    return q.execute();
  }

  capabilities() {
    return CAPABILITIES.map((c) => ({ code: c, ...CAPABILITY_INFO[c] }));
  }

  async create(dto: CreateRoleDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const dup = await trx.selectFrom('roles').select('id').where('code', '=', dto.code).executeTakeFirst();
      if (dup) throw new ConflictException(`კოდი ${dto.code} უკვე გამოყენებულია`);
      const max = await trx.selectFrom('roles').select((eb) => eb.fn.max('sort_order').as('m')).executeTakeFirst();
      const row = await trx.insertInto('roles').values({
        code: dto.code, name: dto.name.trim(), description: dto.description?.trim() || null, capabilities: [...new Set(dto.capabilities)],
        is_system: false, sort_order: dto.sort_order ?? (Number(max?.m ?? 0) || 0) + 10,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_ROLE', entityName: 'roles', entityId: row.id, newData: dto }, trx);
      return row;
    });
  }

  /** სისტემური როლი: იცვლება მხოლოდ დასახელება/აღწერა/რიგი/აქტიურობა (admin — არ ითიშება). უფლებების ცვლილება ყველა მფლობელს ეხება */
  async update(id: string, dto: UpdateRoleDto, ctx: AuditContext) {
    const res = await this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('roles').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('როლი ვერ მოიძებნა');
      if (old.is_system && dto.capabilities !== undefined) {
        const same = dto.capabilities.length === old.capabilities.length && dto.capabilities.every((c) => old.capabilities.includes(c));
        if (!same) throw new ForbiddenException('სისტემური როლის უფლებები არ იცვლება — შექმენით ახალი როლი');
      }
      if (old.code === 'admin' && dto.is_active === false) throw new ForbiddenException('ადმინისტრატორის როლი არ ითიშება');
      const set = {
        ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.description !== undefined && { description: dto.description?.trim() || null }),
        ...(dto.capabilities !== undefined && !old.is_system && { capabilities: [...new Set(dto.capabilities)] }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
      };
      if (!Object.keys(set).length) return { row: old, capsChanged: false };
      const row = await trx.updateTable('roles').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      const capsChanged = 'capabilities' in set || 'is_active' in set;
      if (capsChanged) {
        await this.users.assertAdminRemains(trx);
        // უფლებების შეცვლა → მფლობელების სესიები განახლდება (ახალი access token ახალი უფლებებით)
        await trx.updateTable('auth_sessions').set({ revoked_at: sql`now()`, revoke_reason: 'role_changed' })
          .where('revoked_at', 'is', null).where('user_id', 'in', (eb) => eb.selectFrom('user_roles').select('user_id').where('role_id', '=', id)).execute();
      }
      await this.audit.log(ctx, { action: 'UPDATE_ROLE', entityName: 'roles', entityId: id, oldData: old, newData: set }, trx);
      return { row, capsChanged };
    });
    if (res.capsChanged) invalidateAllUserStatus();
    return res.row;
  }

  async remove(id: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('roles').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException('როლი ვერ მოიძებნა');
      if (r.is_system) throw new ForbiddenException('სისტემური როლი არ იშლება');
      const used = await trx.selectFrom('user_roles').select('user_id').where('role_id', '=', id).limit(1).executeTakeFirst();
      if (used) throw new ConflictException('როლი მომხმარებლებს აქვს მინიჭებული — გათიშეთ ან ჯერ მოხსენით მომხმარებლებს');
      await trx.deleteFrom('roles').where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'DELETE_ROLE', entityName: 'roles', entityId: id, oldData: r }, trx);
      return { id, deleted: true };
    });
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}
  /** როლების სია (აქტიურები — ყველა ადმინისტრირების ეკრანისთვის; გათიშულებიც — admin) */
  @Get() @Roles('admin', 'hr')
  list(@Query('active') active?: string) { return this.roles.list(active !== 'true'); }
  @Get('capabilities') @Roles('admin', 'hr')
  capabilities() { return this.roles.capabilities(); }
  @Post() @Roles('admin')
  create(@Body() dto: CreateRoleDto, @Req() req: Request) {
    return this.roles.create(dto, auditCtx(req));
  }
  /** წაშლა — მხოლოდ კლინიკის როლი, რომელიც არცერთ მომხმარებელს არ აქვს (შეცდომით შექმნილი). სხვა შემთხვევაში — გათიშვა */
  @Delete(':id') @Roles('admin')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.roles.remove(id, auditCtx(req)); }
  @Patch(':id') @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto, @Req() req: Request) { return this.roles.update(id, dto, auditCtx(req)); }
}

@Module({ imports: [UsersModule], controllers: [RolesController], providers: [RolesService] })
export class RolesModule {}
