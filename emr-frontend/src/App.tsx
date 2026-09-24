import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Role } from './api/client';
import { useAuth } from './auth/AuthContext';
import Shell, { homeFor } from './components/Shell';
import { Loading } from './components/ui';
import Cashier from './pages/Cashier';
import ChangePassword from './pages/ChangePassword';
import DoctorQueue from './pages/DoctorQueue';
import Encounter from './pages/Encounter';
import Login from './pages/Login';
import PatientCard from './pages/PatientCard';
import PatientNew from './pages/PatientNew';
import Patients from './pages/Patients';
import Reception from './pages/Reception';

function Guard({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (user.mustChangePassword && loc.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
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
        <Route path="/encounters/:id" element={<Guard roles={['admin', 'doctor', 'nurse']}><Encounter /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to={user ? homeFor(user.role) : '/login'} replace />} />
    </Routes>
  );
}
