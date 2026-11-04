import { ConsultInbox } from './inpatient/DoctorNotes';

/** 0088: კონსულტანტის სია — ჰოსპიტალიზაციები (inpatient) + ER-ის შემთხვევები (er); რომელიმე აქტიურია (moduleRoutes) */
export default function Consults() {
  return (
    <>
      <header className="topbar"><h1>კონსულტაციები</h1><span className="muted" style={{ marginLeft: 12 }}>ჩემთვის / ჩემი განყოფილებისთვის</span></header>
      <div className="content"><ConsultInbox all /></div>
    </>
  );
}
