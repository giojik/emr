# EMR Frontend (React + TypeScript + Vite)

## Dev (ცხელი განახლებით)
```bash
npm ci
npm run dev          # http://localhost:5173 — /api → http://127.0.0.1:3000 (backend: npm run start:dev)
```
VS Code Remote-SSH პორტ 5173-ს ავტომატურად გადმოამისამართებს.

## სტრუქტურა
```
src/api/        client.ts (JWT მეხსიერებაში + refresh cookie), types.ts (API ტიპები)
src/auth/       სესია, login/logout, access token-ის ავტო-განახლება
src/components/ Shell (მენიუ როლის მიხედვით), PatientSearch, AppointmentDialog, AllergyBanner/Dialog, ui
src/pages/      Login, ChangePassword, Reception, Patients, PatientCard, PatientNew, Cashier, DoctorQueue, Encounter
```
შრიფტები ლოკალურია (@fontsource) — ინტერნეტის გარეშეც მუშაობს.
