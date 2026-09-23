import { z } from 'zod';

const bool = (def: boolean) =>
  z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

/** env ცვლადების ვალიდაცია გაშვებისას — არასწორი კონფიგურაციით აპლიკაცია საერთოდ არ ჩაირთვება. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),          // runtime: emr_app როლი
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  CLINIC_TZ: z.string().default('Asia/Tbilisi'),                            // "დღის" საზღვრები განრიგისთვის

  // --- ფაილსაცავი (MinIO / S3) ---
  S3_ENDPOINT: z.string().url().default('http://127.0.0.1:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: z.string().min(8),
  S3_BUCKET: z.string().default('emr-documents'),

  // --- დოკუმენტების ვერიფიკაცია (QR) ---
  // საჯარო მისამართი, რომელსაც QR-კოდი მიუთითებს (სადაზღვევო კომპანია ინტერნეტიდან ხსნის)
  PUBLIC_VERIFY_BASE_URL: z.string().url().default('http://localhost:3000/api/public/verify'),

  // --- JWT / სესიები ---
  JWT_SECRET: z.string().min(32, 'JWT_SECRET მინიმუმ 32 სიმბოლო (openssl rand -hex 32)'),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),     // 15 წთ
  REFRESH_TTL_HOURS: z.coerce.number().int().positive().default(12),        // ერთი ცვლა
  COOKIE_SECURE: bool(true),                                                // dev (http) → false

  // --- Login პოლიტიკა ---
  LOGIN_MAX_FAILED: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  // --- ავტორიზაციის პროვაიდერები (კლინიკის კონფიგურაცია) ---
  AUTH_LOCAL_ENABLED: bool(true),
  AUTH_LDAP_ENABLED: bool(false),
  LDAP_URL: z.string().optional(),                     // ldaps://dc01.innovamedical.local:636
  LDAP_BIND_TEMPLATE: z.string().optional(),           // {username}@innovamedical.local  ან  uid={username},ou=people,dc=...
  LDAP_BASE_DN: z.string().optional(),                 // DC=innovamedical,DC=local (საჭიროა ჯგუფის შემოწმებისთვის)
  LDAP_USER_FILTER: z.string().default('(sAMAccountName={username})'),
  LDAP_REQUIRED_GROUP_DN: z.string().optional(),       // CN=EMR-Users,OU=Groups,DC=... (ცარიელი = შემოწმების გარეშე)
  LDAP_NESTED_GROUPS: bool(true),                      // AD: LDAP_MATCHING_RULE_IN_CHAIN
  LDAP_TLS_CA_FILE: z.string().optional(),             // შიდა CA სერტიფიკატი (PEM)
  LDAP_TLS_REJECT_UNAUTHORIZED: bool(true),
  LDAP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
}).superRefine((e, ctx) => {
  if (!e.AUTH_LOCAL_ENABLED && !e.AUTH_LDAP_ENABLED) {
    ctx.addIssue({ code: 'custom', message: 'მინიმუმ ერთი პროვაიდერი უნდა იყოს ჩართული (AUTH_LOCAL_ENABLED / AUTH_LDAP_ENABLED)' });
  }
  if (e.AUTH_LDAP_ENABLED) {
    if (!e.LDAP_URL) ctx.addIssue({ code: 'custom', path: ['LDAP_URL'], message: 'AUTH_LDAP_ENABLED=true მოითხოვს LDAP_URL-ს' });
    if (!e.LDAP_BIND_TEMPLATE?.includes('{username}')) ctx.addIssue({ code: 'custom', path: ['LDAP_BIND_TEMPLATE'], message: 'უნდა შეიცავდეს {username}-ს' });
    if (e.LDAP_REQUIRED_GROUP_DN && !e.LDAP_BASE_DN) ctx.addIssue({ code: 'custom', path: ['LDAP_BASE_DN'], message: 'ჯგუფის შემოწმებას სჭირდება LDAP_BASE_DN' });
  }
  if (e.NODE_ENV === 'production' && !e.COOKIE_SECURE) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'production-ში COOKIE_SECURE უნდა იყოს true' });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
export function loadEnv(): Env {
  if (cached) return cached;
  try { process.loadEnvFile(); } catch { /* .env არ არის (production-ში env კონტეინერიდან მოდის) */ }
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('✘ არასწორი env კონფიგურაცია:\n' + z.prettifyError(parsed.error));
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
