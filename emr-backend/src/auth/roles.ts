/**
 * უფლებების (capabilities) დახურული კატალოგი — ემთხვევა DB-ის roles.capabilities CHECK-ს.
 * როლები (სისტემური + კლინიკის შექმნილი) ბაზაშია: როლი = უფლებების ნაკრები; მომხმარებელს — რამდენიმე როლი.
 * `@Roles(...)` decorator ამოწმებს: აქვს თუ არა მომხმარებელს ჩამოთვლილთაგან ერთი უფლება მაინც.
 */
export const ROLES = ['admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager', 'phlebotomist',
  'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse'] as const;
export type Role = (typeof ROLES)[number];
export const CAPABILITIES = ROLES;
export type Capability = Role;

/** JWT + ბაზიდან აღდგენილი მიმდინარე მომხმარებელი (req.user) */
export interface AuthUser {
  id: string;
  /** ძირითადი როლის კოდი (საწყისი გვერდი / ჩვენება) — უფლებების შესამოწმებლად გამოიყენეთ has() */
  role: string;
  /** ეფექტური უფლებები — ყველა აქტიური როლის გაერთიანება */
  caps: Role[];
  name: string;
  mustChangePassword: boolean;
}

/** აქვს თუ არა ჩამოთვლილთაგან ერთი უფლება მაინც */
export const has = (u: Pick<AuthUser, 'caps'>, ...caps: Role[]) => caps.some((c) => u.caps.includes(c));
