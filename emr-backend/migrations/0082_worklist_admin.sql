-- 0082_worklist_admin.sql
-- სამუშაო სიები (D5), ეტაპი 2 / 4 — ადმინისტრაცია / ლოჯისტიკის სისტემური წყაროები (ვირტუალური — ცხრილი არ ემატება).
--
--  • 30 წყარო: მარაგი (9), შესყიდვები (4), ფინანსები / ბილინგი / ტარიფები (8), CSSD (4), ინვენტარი (2), რეგისტრატურა / სალარო (3).
--  • A1 — სამოქმედო უფლება ≠ პასუხისმგებლობა: ჩანაწერი ლოკაციის / ობიექტის „ბუნებრივ მფლობელთან“; ზოგადი უფლება (stock_manager,
--      storekeeper …) — მხოლოდ მფლობელის არარსებობისას.
--  • B1 — განყოფილების მხარე (`dept_side`): heads — ხელმძღვანელი (is_section_head / manager); ხელმძღვანელის გარეშე — ყველა წევრი; all — ყველა წევრი.
--  • C1 — მასობრივი წყაროები (ვადა / მინიმუმი / ცარიელი ამპულა / ქლეიმის მომზადება) — ერთი ჩანაწერი ლოკაციაზე / გადამხდელზე.
--  • F1 — `sla_hours`: ვადა იქ, სადაც წყაროს თავისი არ აქვს (გაგზავნიდან); 0 — ვადის გარეშე.
--  • ახალი უფლება არ ემატება (47).
-- ================================================================ 1. პარამეტრები (ნაგულისხმევი; არსებული მნიშვნელობები უპირატესია)
UPDATE system_modules
   SET settings = '{"dept_side": "heads", "stk_expiry_days": 30,
                    "sla_hours": {"stk_approve": 24, "stk_issue": 24, "stk_receive": 24, "stk_urgent": 4, "proc_approve": 48, "asset_move": 72},
                    "period_close_day": 10, "claim_build_day": 5, "ipd_finalize_days": 3, "appt_open_days": 2, "debt_days": 30,
                    "reg_scope": "all", "bi_due_hours": 48}'::jsonb || settings,
       description = '„ჩემი დავალებები“: სხვა მოდულების ღია საქმეები (სისტემური — ხარისხი, IPC, ბიომედი, ცვლები, მარაგი, შესყიდვები, ფინანსები, ტარიფები, CSSD, ინვენტარი, რეგისტრატურა) + ხელით შექმნილი დავალებები (პირზე / როლზე / განყოფილებაზე / მორიგეზე), ვადა, პრიორიტეტი, ესკალაცია; ხელმძღვანელის ხედი'
 WHERE code = 'worklist';

-- ================================================================ 2. ინდექსები (წყაროების მოთხოვნებისთვის)
CREATE INDEX IF NOT EXISTS idx_stock_lots_quarantine   ON stock_lots (item_id) WHERE status = 'quarantine';
CREATE INDEX IF NOT EXISTS idx_proc_po_pending         ON proc_orders (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ap_invoices_mismatch    ON ap_invoices (created_at) WHERE match_status = 'mismatch' AND status <> 'void';
CREATE INDEX IF NOT EXISTS idx_fin_claims_open         ON fin_claims (due_date) WHERE status IN ('sent', 'partial');
CREATE INDEX IF NOT EXISTS idx_fin_claim_items_open    ON fin_claim_items (claim_id) WHERE resolution IS NULL AND resp_status IN ('rejected', 'partial');
CREATE INDEX IF NOT EXISTS idx_invoices_unfinalized    ON invoices (encounter_id) WHERE finalized_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asset_writeoffs_pending ON asset_writeoffs (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cssd_packs_dept         ON cssd_packs (issued_department_id, expires_on) WHERE issued_department_id IS NOT NULL AND status IN ('issued', 'recalled');
CREATE INDEX IF NOT EXISTS idx_cssd_cycles_bi_pending  ON cssd_cycles (started_at) WHERE bi_result = 'pending';
CREATE INDEX IF NOT EXISTS idx_appointments_open       ON appointments (scheduled_start) WHERE status IN ('scheduled', 'confirmed');
