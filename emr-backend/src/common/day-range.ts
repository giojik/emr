import { sql } from 'kysely';

/** კლინიკის ლოკალური დღის [დასაწყისი, დასასრული) timestamptz-ად — "დღის განრიგისთვის" */
export function dayRange(date: string, tz: string) {
  return [
    sql<Date>`((${date})::date)::timestamp AT TIME ZONE ${tz}`,
    sql<Date>`((${date})::date + 1)::timestamp AT TIME ZONE ${tz}`,
  ] as const;
}
