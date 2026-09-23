# EMR Backend (NestJS + Kysely)

## სტრუქტურა
```
migrations/          სუფთა SQL migration-ები (NNNN_name.sql) — schema-ს ჭეშმარიტების წყარო
src/migrate.ts       migration runner (forward-only, checksum, advisory lock)
src/database/db.d.ts ავტოგენერირებული ტიპები (npm run db:codegen) — ხელით არ შეცვალოთ
src/main.ts          API (HTTP, /api)
src/worker.ts        ფონური პროცესები (რიგები — შემდეგ ეტაპზე)
src/audit/           აუდიტ-ჟურნალი
src/patients/        მაგალითი-მოდული (MPI): ძებნა, რეგისტრაცია, ბარათი
```

## Workflow: schema-ს ცვლილება
1. `npm run migration:new -- add_something`
2. SQL-ის დაწერა `migrations/NNNN_add_something.sql`-ში
3. `npm run migration:run:dev`
4. `npm run db:codegen`   ← TS ტიპები ბაზიდან განახლდება
5. კოდი + commit (migration + db.d.ts ერთად)

გამოყენებული migration ფაილი **არასოდეს** იცვლება — runner checksum-ით აღმოაჩენს და გაჩერდება.

## ავტორიზაცია
- ყველა endpoint დახურულია ნაგულისხმევად; ღიაა მხოლოდ `@Public()` (login, refresh, logout, health).
- როლები: `@Roles('doctor', 'admin')` — სია `src/auth/roles.ts`-ში, ემთხვევა DB constraint-ს.
- პროვაიდერი თითოეულ მომხმარებელზეა (`users.auth_provider`): `local` (argon2id) ან `ldap` (AD bind).
  კლინიკა ირთავს/თიშავს: `AUTH_LOCAL_ENABLED`, `AUTH_LDAP_ENABLED`.
- Access token (JWT, 15 წთ) — `Authorization: Bearer`. Refresh — httpOnly cookie `emr_rt`, rotation + reuse detection.
- **Break-glass:** ყოველთვის შეინახეთ ერთი ლოკალური admin — DC-ის გათიშვისას LDAP მომხმარებლები ვერ შევლენ.

```bash
npm run user -- create --email admin@clinic.ge --first-name ... --last-name ... --personal-number ... --role admin
npm run user -- create ... --role doctor --provider ldap --ldap-username giojik
npm run user -- reset-password --email ...   |   unlock --email ...   |   disable --email ...
```
