import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import net from 'node:net';
import os from 'node:os';
import { InjectDb, type Database } from '../database/database.module';
import { AstmLink, buildNoOrder, buildOrder, DEFAULT_ASTM, delimsFrom, parseMessage, type AstmSettings } from './astm';
import * as hl7 from './hl7';
import { LabIngestService, type OrderInfo } from './lab-ingest.service';

interface InstrumentCfg {
  id: string; name: string; protocol: 'astm' | 'hl7'; conn_mode: 'client' | 'server'; host: string | null; port: number;
  order_mode: 'none' | 'query' | 'push'; settings: Record<string, unknown>; updated_at: Date;
}
const RECONNECT_MS = 5_000;
const PUSH_EVERY_MS = 5_000;
const RELOAD_EVERY_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const RETENTION_DAYS = 30;

/** ერთი ანალიზატორი: TCP კავშირი (კლიენტი ან სერვერი) + პროტოკოლის სესია */
class Runner {
  private sock: net.Socket | null = null;
  private server: net.Server | null = null;
  private stopped = false;
  private reconnect: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private astm: AstmLink | null = null;
  private hl7Waiter: { resolve: (ok: boolean, text?: string) => void; timer: NodeJS.Timeout } | null = null;
  private pushing = false;
  private readonly log: Logger;

  constructor(readonly cfg: InstrumentCfg, private readonly m: GatewayManager) { this.log = new Logger(`Lab:${cfg.name}`); }

  get sendName() { return this.cfg.settings.send_patient_name === true; }
  private get astmSettings(): AstmSettings {
    const s = this.cfg.settings;
    return { specimen_field: Number(s.specimen_field) || DEFAULT_ASTM.specimen_field, code_component: Number(s.code_component) || DEFAULT_ASTM.code_component,
      query_component: Number(s.query_component) || null };
  }

  start() {
    if (this.cfg.conn_mode === 'server') {
      this.server = net.createServer((s) => this.attach(s));
      this.server.on('error', (e) => { void this.m.status(this.cfg.id, 'error', null, e.message); this.log.error(e.message); });
      this.server.listen(this.cfg.port, () => { void this.m.status(this.cfg.id, 'listening', null, null); this.log.log(`უსმენს :${this.cfg.port}`); });
    } else this.connect();
    this.pushTimer = setInterval(() => void this.pushTick(), PUSH_EVERY_MS);
  }
  stop() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.astm?.close(); this.sock?.destroy(); this.server?.close();
  }

  private connect() {
    if (this.stopped) return;
    void this.m.status(this.cfg.id, 'connecting', `${this.cfg.host}:${this.cfg.port}`, null);
    const s = net.createConnection({ host: this.cfg.host ?? '', port: this.cfg.port });
    s.setTimeout(10_000, () => { if (!this.sock) s.destroy(new Error('კავშირის timeout')); });
    s.once('connect', () => { s.setTimeout(0); this.attach(s); });
    s.once('error', (e) => { if (!this.sock) { void this.m.status(this.cfg.id, 'error', `${this.cfg.host}:${this.cfg.port}`, e.message); this.retry(); } });
  }
  private retry() { if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), RECONNECT_MS); }

  /** ახალი სოკეტი (კლიენტის კავშირი ან სერვერზე შემოსული) — ძველი იცვლება ახლით */
  private attach(s: net.Socket) {
    if (this.sock) { this.log.warn('ახალი კავშირი — ძველი იხურება'); this.astm?.close(); this.sock.destroy(); }
    this.sock = s; s.setKeepAlive(true, 30_000); s.setNoDelay(true);
    const peer = `${s.remoteAddress?.replace('::ffff:', '')}:${s.remotePort}`;
    void this.m.status(this.cfg.id, 'connected', peer, null);
    this.log.log(`დაკავშირდა ${peer}`);
    if (this.cfg.protocol === 'astm') {
      const link = new AstmLink((b) => s.write(b));
      this.astm = link;
      link.on('message', (recs: string[]) => void this.onAstm(recs));
      link.on('log', (t: string) => this.log.warn(t));
      link.on('error', (e: Error) => this.log.warn(e.message));
      s.on('data', (d) => link.feed(d));
    } else {
      const dec = new hl7.MllpDecoder((msg) => void this.onHl7(msg));
      s.on('data', (d) => dec.feed(d));
    }
    s.on('close', () => {
      if (this.sock !== s) return;
      this.sock = null; this.astm?.close(); this.astm = null;
      if (this.hl7Waiter) { clearTimeout(this.hl7Waiter.timer); this.hl7Waiter.resolve(false, 'კავშირი გაწყდა'); this.hl7Waiter = null; }
      void this.m.status(this.cfg.id, this.cfg.conn_mode === 'server' ? 'listening' : 'offline', null, null);
      this.log.warn('კავშირი დაიხურა');
      if (this.cfg.conn_mode === 'client') this.retry();
    });
    s.on('error', (e) => this.log.warn(e.message));
  }

  // ---------------------------------------------------------------- ASTM
  private async onAstm(recs: string[]) {
    try {
      const p = parseMessage(recs, this.astmSettings);
      const kind = p.queries.length ? 'query' : p.results.length ? 'results' : 'other';
      const msgId = await this.m.message(this.cfg.id, 'in', kind, recs.join('\n'),
        kind === 'results' ? `${p.results.length} შედეგი · ${[...new Set(p.results.map((r) => r.barcode))].join(', ')}` : kind === 'query' ? `ქვერი: ${p.queries.map((q) => q.barcode).join(', ')}` : null);
      if (p.results.length) {
        const r = await this.m.ingest.ingest(this.cfg.id, msgId, p.results);
        this.log.log(`შედეგები: მიბმული ${r.applied}, დასამუშავებელი ${r.unmatched}`);
      }
      const d = delimsFrom(recs.find((r) => r.startsWith('H')));
      for (const q of p.queries) {
        const o = this.cfg.order_mode === 'none' ? null : await this.m.ingest.ordersForBarcode(this.cfg.id, q.barcode, this.sendName);
        const out = o?.codes.length ? buildOrder({ ...o, reportType: 'Q' }, d) : buildNoOrder(q.barcode, d);
        await this.m.message(this.cfg.id, 'out', 'orders', out.join('\n'), o?.codes.length ? `${q.barcode}: ${o.codes.join(', ')}` : `${q.barcode}: შეკვეთა არ არის`);
        await this.astm?.send(out).catch((e: Error) => this.m.message(this.cfg.id, 'out', 'orders', out.join('\n'), null, e.message));
      }
    } catch (e) {
      this.log.error((e as Error).message);
      await this.m.message(this.cfg.id, 'in', 'other', recs.join('\n'), null, (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- HL7
  private async onHl7(raw: string) {
    let m: hl7.Hl7;
    try { m = hl7.parse(raw); } catch { return; }
    try {
      if (m.type === 'ACK') {
        await this.m.message(this.cfg.id, 'in', 'ack', raw.replace(/\r/g, '\n'), null);
        const msa = m.segs.find((s) => s[0] === 'MSA');
        if (this.hl7Waiter) { clearTimeout(this.hl7Waiter.timer); this.hl7Waiter.resolve(hl7.f(msa, 1) === 'AA' || hl7.f(msa, 1) === 'CA', hl7.f(msa, 3)); this.hl7Waiter = null; }
        return;
      }
      const settings = { barcode_field: (this.cfg.settings.barcode_field as hl7.Hl7Settings['barcode_field']) || hl7.DEFAULT_HL7.barcode_field,
        code_component: Number(this.cfg.settings.code_component) || hl7.DEFAULT_HL7.code_component };
      if (m.type === 'ORU' || m.type === 'OUL') {
        const res = hl7.results(m, settings);
        const id = await this.m.message(this.cfg.id, 'in', 'results', raw.replace(/\r/g, '\n'), `${res.length} შედეგი · ${[...new Set(res.map((r) => r.barcode))].join(', ')}`);
        const r = await this.m.ingest.ingest(this.cfg.id, id, res);
        this.log.log(`შედეგები: მიბმული ${r.applied}, დასამუშავებელი ${r.unmatched}`);
        this.write(hl7.ack(m, 'AA'));
        return;
      }
      if (m.type === 'QRY' || m.type === 'QBP') {
        const b = hl7.queryBarcode(m);
        await this.m.message(this.cfg.id, 'in', 'query', raw.replace(/\r/g, '\n'), `ქვერი: ${b ?? '?'}`);
        this.write(hl7.ack(m, 'AA'));
        const o = b && this.cfg.order_mode !== 'none' ? await this.m.ingest.ordersForBarcode(this.cfg.id, b, this.sendName) : null;
        if (o?.codes.length) await this.sendOrm(o);
        else await this.m.message(this.cfg.id, 'out', 'orders', `${b ?? '?'}: შეკვეთა არ არის`, `${b ?? '?'}: შეკვეთა არ არის`);
        return;
      }
      await this.m.message(this.cfg.id, 'in', 'other', raw.replace(/\r/g, '\n'), `${m.type}^${m.event}`);
      this.write(hl7.ack(m, 'AA'));
    } catch (e) {
      this.log.error((e as Error).message);
      await this.m.message(this.cfg.id, 'in', 'other', raw.replace(/\r/g, '\n'), null, (e as Error).message);
      this.write(hl7.ack(m, 'AE', (e as Error).message));
    }
  }
  private write(msg: string) { this.sock?.write(hl7.mllp(msg)); }
  private sendOrm(o: OrderInfo): Promise<boolean> {
    const msg = hl7.orm(o, { app: '', fac: '' }, String(this.cfg.settings.hl7_version ?? '2.3.1'));
    return new Promise((resolve) => {
      if (!this.sock) { resolve(false); return; }
      void this.m.message(this.cfg.id, 'out', 'orders', msg.replace(/\r/g, '\n'), `${o.barcode}: ${o.codes.join(', ')}`);
      const timer = setTimeout(() => { this.hl7Waiter = null; resolve(false); }, 15_000);
      this.hl7Waiter = { resolve: (ok) => resolve(ok), timer };
      this.write(msg);
    });
  }

  // ---------------------------------------------------------------- push: მიღებული სინჯარების შეკვეთები
  private async pushTick() {
    if (this.cfg.order_mode !== 'push' || !this.sock || this.pushing) return;
    if (this.astm?.busy) return;
    this.pushing = true;
    try {
      for (const o of await this.m.ingest.pendingPush(this.cfg.id, this.sendName)) {
        if (!this.sock) break;
        let ok = false; let err: string | undefined;
        if (this.cfg.protocol === 'astm') {
          const recs = buildOrder({ ...o, reportType: 'O' });
          await this.m.message(this.cfg.id, 'out', 'orders', recs.join('\n'), `${o.barcode}: ${o.codes.join(', ')}`);
          try { await this.astm?.send(recs); ok = !!this.astm; } catch (e) { err = (e as Error).message; }
        } else {
          ok = await this.sendOrm(o); if (!ok) err = 'ACK არ მოვიდა ან უარყოფილია';
        }
        await this.m.ingest.markOrder(o.order_id, ok, err);
      }
    } catch (e) { this.log.error((e as Error).message); } finally { this.pushing = false; }
  }
}

@Injectable()
export class GatewayManager implements OnApplicationShutdown {
  private readonly log = new Logger('LabGateway');
  private runners = new Map<string, Runner>();
  private timers: NodeJS.Timeout[] = [];
  constructor(@InjectDb() private readonly db: Database, readonly ingest: LabIngestService) {}

  async start() {
    const now = new Date();
    await this.db.insertInto('lab_gateway_state').values({ id: 1, heartbeat_at: now, started_at: now, version: process.env.npm_package_version ?? null, hostname: os.hostname() })
      .onConflict((oc) => oc.column('id').doUpdateSet({ heartbeat_at: now, started_at: now, hostname: os.hostname() })).execute();
    // წინა გაშვების სტატუსები აღარ არის აქტუალური
    await this.db.updateTable('lab_instruments').set({ status: 'offline', peer: null, status_at: now }).execute();
    await this.reload();
    this.timers.push(setInterval(() => void this.reload().catch((e) => this.log.error(e.message)), RELOAD_EVERY_MS));
    this.timers.push(setInterval(() => void this.db.updateTable('lab_gateway_state').set({ heartbeat_at: new Date() }).where('id', '=', 1).execute().catch(() => undefined), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.purge(), 3_600_000));
    void this.purge();
    this.log.log('emr-lab-gateway გაეშვა');
  }

  /** კონფიგურაციის სინქრონიზაცია: ახალი → ჩართვა; გათიშული/წაშლილი → გაჩერება; შეცვლილი → გადატვირთვა */
  private async reload() {
    const rows = await this.db.selectFrom('lab_instruments as i').innerJoin('lab_methods as m', 'm.id', 'i.method_id')
      .select(['i.id', 'm.name', 'i.protocol', 'i.conn_mode', 'i.host', 'i.port', 'i.order_mode', 'i.settings', 'i.updated_at'])
      .where('i.is_enabled', '=', true).where('m.is_active', '=', true).execute();
    const want = new Map(rows.map((r) => [r.id, r as unknown as InstrumentCfg]));
    for (const [id, run] of this.runners) {
      const c = want.get(id);
      if (!c || new Date(c.updated_at).getTime() !== new Date(run.cfg.updated_at).getTime()) {
        run.stop(); this.runners.delete(id);
        if (!c) await this.status(id, 'offline', null, null);
      }
    }
    for (const [id, c] of want) {
      if (this.runners.has(id)) continue;
      const r = new Runner(c, this); this.runners.set(id, r); r.start();
    }
  }

  async status(id: string, status: 'offline' | 'connecting' | 'listening' | 'connected' | 'error', peer: string | null, error: string | null) {
    await this.db.updateTable('lab_instruments').set({ status, peer, status_at: sql`now()`, ...(error !== null ? { last_error: error } : status === 'connected' ? { last_error: null } : {}) })
      .where('id', '=', id).execute().catch(() => undefined);
  }
  async message(id: string, direction: 'in' | 'out', kind: string, raw: string, summary: string | null, error?: string) {
    const r = await this.db.insertInto('lab_instrument_messages').values({ instrument_id: id, direction, kind, raw, summary, error: error ?? null }).returning('id').executeTakeFirst();
    if (direction === 'in') await this.db.updateTable('lab_instruments').set({ last_message_at: sql`now()` }).where('id', '=', id).execute();
    return r ? String(r.id) : null;
  }
  private async purge() {
    await this.db.deleteFrom('lab_instrument_messages').where('created_at', '<', sql<Date>`now() - make_interval(days => ${RETENTION_DAYS})`).execute().catch(() => undefined);
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.runners.values()) r.stop();
  }
}
