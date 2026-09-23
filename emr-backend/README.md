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
