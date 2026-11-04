/**
 * 0086 (F / H): route → მოდული — ერთი რუკა მენიუს, საწყისი გვერდის, route guard-ისა და e2e მატრიცისთვის.
 * მასივი = „რომელიმე“ აქტიურია (მაგ. დიაგნოსტიკის ჰაბი). ჩანაწერი არ არის — ბირთვი (ყოველთვის).
 * უფრო ზუსტი (გრძელი) პრეფიქსი უპირატესია.
 */
export type ModuleReq = string | string[];

export const DX_ANY = ['lab', 'radiology', 'endoscopy'];

export const ROUTE_MODULES: [prefix: string, module: ModuleReq][] = [
  ['/tasks', 'worklist'],
  ['/doctor', 'outpatient'],
  ['/visits', 'outpatient'],
  ['/er', 'er'],
  ['/inpatient', 'inpatient'],
  ['/consults', ['inpatient', 'er']],   // 0088: კონსულტაციები (სტაციონარი + ER)
  ['/or', 'or'],
  ['/collection', 'lab'],
  ['/diagnostics/lab', 'lab'],
  ['/diagnostics/radiology', 'radiology'],
  ['/diagnostics/endoscopy', 'endoscopy'],
  ['/diagnostics/referrals', 'outpatient'],
  ['/diagnostics', DX_ANY],
  ['/stock/verification', 'pharmacy'],
  ['/stock/controlled', 'pharmacy'],
  ['/stock/lab', 'lab_stock'],
  ['/stock', 'stock'],
  ['/procurement', 'procurement'],
  ['/finance', 'finance'],
  ['/assets', 'asset_register'],
  ['/bme', 'bme'],
  ['/cssd', 'cssd'],
  ['/roster', 'roster'],
  ['/dashboard', 'reporting'],
  ['/quality', 'quality'],
  ['/ipc', 'ipc'],
  ['/antibiogram', 'ipc'],
  ['/admin/drg', 'drg'],
  ['/admin/scrubber', 'scrubber'],
  ['/admin/claim-export', 'finance'],
  ['/admin/config-package', ['drg', 'scrubber']],
  ['/admin/beds', 'inpatient'],
  ['/admin/billing', 'inpatient'],
  ['/admin/icu', 'icu'],
  ['/admin/er', 'er'],
  ['/admin/or', 'or'],
  ['/admin/catalog', DX_ANY],
  ['/admin/analyzers', 'lab_gateway'],
  ['/admin/lab-delivery', 'lab'],
  ['/admin/devices', 'bme'],
  ['/admin/reporting', 'reporting'],
  ['/admin/frequencies', ['ipd_orders', 'outpatient']],
];

/** მისამართის მოდული (query / hash — იგნორირდება); null — ბირთვი */
export function moduleForPath(path: string): ModuleReq | null {
  const p = path.split(/[?#]/)[0];
  let best: [string, ModuleReq] | null = null;
  for (const r of ROUTE_MODULES) if ((p === r[0] || p.startsWith(`${r[0]}/`)) && (!best || r[0].length > best[0].length)) best = r;
  return best ? best[1] : null;
}
