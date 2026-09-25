import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Role } from './api/client';
import { useAuth } from './auth/AuthContext';
import Shell, { homeFor } from './components/Shell';
import { Loading } from './components/ui';
import Cashier from './pages/Cashier';
import ChangePassword from './pages/ChangePassword';
import Collection from './pages/Collection';
import DiagnosticsHub from './pages/DiagnosticsHub';
import DoctorQueue from './pages/DoctorQueue';
import Encounter from './pages/Encounter';
import Login from './pages/Login';
import PatientCard from './pages/PatientCard';
import PatientNew from './pages/PatientNew';
import Patients from './pages/Patients';
import Reception from './pages/Reception';
import AdminLayout from './pages/admin/AdminLayout';
import Allergens from './pages/admin/Allergens';
import Audit from './pages/admin/Audit';
import Catalog from './pages/admin/Catalog';
import Clinic from './pages/admin/Clinic';
import ConsentTypes from './pages/admin/ConsentTypes';
import Departments from './pages/admin/Departments';
import Devices from './pages/admin/Devices';
import Overrides from './pages/admin/Overrides';
import Tariffs from './pages/admin/Tariffs';
import Users from './pages/admin/Users';

function Guard({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (user.mustChangePassword && loc.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function AdminHome() {
  const { user } = useAuth();
  return <Navigate to={user?.role === 'pharmacist' ? '/admin/allergens' : user?.role === 'billing' ? '/admin/tariffs' : user?.role === 'lab_doctor' || user?.role === 'lab_manager' ? '/admin/catalog' : '/admin/users'} replace />;
}

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<Guard><ChangePassword /></Guard>} />
      <Route element={<Guard><Shell /></Guard>}>
        <Route path="/reception" element={<Guard roles={['admin', 'receptionist']}><Reception /></Guard>} />
        <Route path="/patients" element={<Patients />} />
        <Route path="/patients/new" element={<Guard roles={['admin', 'receptionist']}><PatientNew /></Guard>} />
        <Route path="/patients/:id" element={<PatientCard />} />
        <Route path="/cashier" element={<Guard roles={['admin', 'receptionist', 'billing']}><Cashier /></Guard>} />
        <Route path="/cashier/:encounterId" element={<Guard roles={['admin', 'receptionist', 'billing']}><Cashier /></Guard>} />
        <Route path="/doctor" element={<Guard roles={['doctor']}><DoctorQueue mine /></Guard>} />
        <Route path="/visits" element={<Guard roles={['admin', 'nurse', 'doctor']}><DoctorQueue /></Guard>} />
        <Route path="/diagnostics" element={<Navigate to={user?.role === 'radiographer' || user?.role === 'radiologist' ? '/diagnostics/radiology' : user?.role === 'endoscopist' || user?.role === 'endoscopy_nurse' ? '/diagnostics/endoscopy' : '/diagnostics/lab'} replace />} />
        <Route path="/diagnostics/:section" element={<Guard roles={['admin', 'diagnostic', 'lab_doctor', 'lab_manager', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse', 'receptionist']}><DiagnosticsHub /></Guard>} />
        <Route path="/collection" element={<Guard roles={['admin', 'nurse', 'phlebotomist', 'diagnostic', 'lab_doctor']}><Collection /></Guard>} />
        <Route path="/encounters/:id" element={<Guard roles={['admin', 'doctor', 'nurse']}><Encounter /></Guard>} />
        <Route path="/admin" element={<Guard roles={['admin', 'pharmacist', 'billing', 'lab_doctor', 'lab_manager']}><AdminLayout /></Guard>}>
          <Route index element={<AdminHome />} />
          <Route path="users" element={<Guard roles={['admin']}><Users /></Guard>} />
          <Route path="departments" element={<Guard roles={['admin']}><Departments /></Guard>} />
          <Route path="tariffs" element={<Guard roles={['admin', 'billing']}><Tariffs /></Guard>} />
          <Route path="clinic" element={<Guard roles={['admin']}><Clinic /></Guard>} />
          <Route path="catalog" element={<Guard roles={['admin', 'lab_doctor', 'lab_manager', 'billing']}><Catalog /></Guard>} />
          <Route path="consents" element={<Guard roles={['admin']}><ConsentTypes /></Guard>} />
          <Route path="allergens" element={<Guard roles={['admin', 'pharmacist']}><Allergens /></Guard>} />
          <Route path="overrides" element={<Guard roles={['admin', 'pharmacist']}><Overrides /></Guard>} />
          <Route path="devices" element={<Guard roles={['admin']}><Devices /></Guard>} />
          <Route path="audit" element={<Guard roles={['admin']}><Audit /></Guard>} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to={user ? homeFor(user.role) : '/login'} replace />} />
    </Routes>
  );
}
