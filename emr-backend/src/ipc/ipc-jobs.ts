import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { IPC_FULL, IpcCommon, ipcRules } from './ipc-common';
import { IpcMdroService } from './ipc-mdro';
import { IpcDeviceDaysService } from './ipc-device-days';
import { IpcSignalsService } from './ipc-signals';
import { IpcSsiService } from './ipc-ssi';
import { IpcAbxService } from './ipc-abx';

/**
 * worker (ყოველ 5 წუთში, 0067):
 *  • მიკრობიოლოგიის საბოლოო პასუხები (ბოლო 30 დღე), რომლებიც MDRO-ს წესებით ჯერ არ შემოწმდა (მაგ. API-ს შეცდომა) → შემოწმება;
 *  • ფლაგის ვადა (ipc_mdro_types.expiry_days) ამოიწურა → მოიხსნა („ვადა ამოიწურა“), ინფექციის კონტროლს — შეტყობინება.
 * 0068: სიგნალები (signals.scan — 15 წთ), device-days (deviceDays.tick — საათში ერთხელ) — worker.ts-იდან.
 * 0069: SSI ზედამხედველობა (ssi.tick — საათში ერთხელ): ოპერაციები, გაწერის შემდგომი კონტაქტი, SMS.
 * 0070: ანტიბიოტიკის time-out შეხსენება (abx.tick — 15 წთ, სიგნალებთან ერთად).
 */
@Injectable()
export class IpcJobsService {
  private readonly log = new Logger('IPC-jobs');
  constructor(private readonly c: IpcCommon, private readonly mdro: IpcMdroService, readonly signals: IpcSignalsService, readonly deviceDays: IpcDeviceDaysService, readonly ssi: IpcSsiService, readonly abx: IpcAbxService) {}

  async tick() {
    if (!(await ipcRules(this.c.db))) return { scanned: 0, expired: 0 };
    const pending = await this.c.db.selectFrom('micro_reports as r').select('r.id').where('r.kind', '=', 'final')
      .where('r.issued_at', '>', sql<Date>`now() - interval '30 days'`)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('ipc_micro_scans as s').select('s.report_id').whereRef('s.report_id', '=', 'r.id'))))
      .orderBy('r.issued_at').limit(200).execute();
    let scanned = 0;
    for (const p of pending) {
      try { await this.mdro.scanReport(p.id); scanned++; } catch (e) { this.log.error(`MDRO შემოწმება ${p.id}: ${(e as Error).message}`); }
    }
    const exp = await this.c.db.updateTable('ipc_patient_flags').set({ status: 'cleared', cleared_at: sql`now()`, clear_reason: 'ვადა ამოიწურა (ავტომატურად)' })
      .where('status', '=', 'active').where('expires_at', '<', sql<Date>`now()`).returning(['id', 'mdro_code']).execute();
    if (exp.length) {
      const ipc = (await this.c.usersWith(IPC_FULL)).map((x) => x.id);
      for (const f of exp) await this.c.bell(ipc, { kind: 'ipc_flag', title: `MDRO ფლაგს ვადა გაუვიდა: ${f.mdro_code.toUpperCase()}`, link: `/ipc/flags/${f.id}`, entityId: f.id });
    }
    return { scanned, expired: exp.length };
  }
}
