import { z } from 'zod';

/** env ცვლადების ვალიდაცია გაშვებისას — არასწორი კონფიგურაციით აპლიკაცია საერთოდ არ ჩაირთვება. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),          // runtime: emr_app როლი
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
export function loadEnv(): Env {
  if (cached) return cached;
  try { process.loadEnvFile(); } catch { /* .env არ არის (production-ში env კონტეინერიდან მოდის) */ }
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('✘ არასწორი env კონფიგურაცია:', z.prettifyError(parsed.error));
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
