/** როლების დახურული სია — ემთხვევა DB-ის chk_users_role constraint-ს. */
export const ROLES = ['admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager', 'phlebotomist',
  'radiographer', 'radiologist'] as const;
export type Role = (typeof ROLES)[number];

/** JWT-იდან აღდგენილი მიმდინარე მომხმარებელი (req.user) */
export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  mustChangePassword: boolean;
}
