-- 0016_roles_without_capabilities.sql
-- როლი უფლებების გარეშე = თანამშრომლის პოზიცია (ქირურგი, HR, სამედიცინო ინჟინერი, მძღოლი, სანიტარი…).
-- ასეთი როლი სისტემაში წვდომას არ იძლევა; წვდომა ემატება უფლებების მონიშვნით ან სხვა როლით.
ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse']::VARCHAR(30)[]);
