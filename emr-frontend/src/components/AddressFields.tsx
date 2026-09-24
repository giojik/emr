import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../api/client';
import type { AddressFieldsValue, AddressUnit } from '../api/types';
import { Field, useDebounced } from './ui';

/** მისამართი: მოქალაქე — ქალაქი/მუნიციპალიტეტი → (თბილისი) რაიონი / სოფელი → ქუჩა; უცხოელი — ქვეყანა + მისამართი */
export default function AddressFields({ value, onChange, foreign }: { value: AddressFieldsValue; onChange: (v: AddressFieldsValue) => void; foreign: boolean }) {
  const units = useQuery({ queryKey: ['address-units'], queryFn: () => api<AddressUnit[]>('/patients/address-units'), staleTime: Infinity });
  const set = (k: keyof AddressFieldsValue, v: string) => onChange({ ...value, [k]: v });
  const groups = useMemo(() => {
    const m = new Map<string, AddressUnit[]>();
    units.data?.filter((u) => u.type !== 'district').forEach((u) => m.set(u.region, [...(m.get(u.region) ?? []), u]));
    return [...m.entries()];
  }, [units.data]);
  const districts = units.data?.filter((u) => u.type === 'district' && u.parent_code === value.address_unit_code) ?? [];
  const vq = useDebounced(value.address_village.trim(), 250);
  const villages = useQuery({
    queryKey: ['villages', value.address_unit_code, vq],
    queryFn: () => api<string[]>(`/patients/address-units/${value.address_unit_code}/villages`, { query: { q: vq } }),
    enabled: !!value.address_unit_code && districts.length === 0 && vq.length >= 1,
  });

  if (foreign) {
    return (
      <>
        <Field label="ქვეყანა (მისამართის)" htmlFor="acountry" hint="ISO კოდი, მაგ. TUR"><input id="acountry" className="input mono" maxLength={3} value={value.address_country} onChange={(e) => set('address_country', e.target.value.toUpperCase())} /></Field>
        <Field label="მისამართი" htmlFor="aline"><input id="aline" className="input" value={value.address_line} onChange={(e) => set('address_line', e.target.value)} /></Field>
      </>
    );
  }
  return (
    <>
      <Field label="ქალაქი / მუნიციპალიტეტი" htmlFor="aunit">
        <select id="aunit" className="select" value={value.address_unit_code} onChange={(e) => onChange({ ...value, address_unit_code: e.target.value, address_district_code: '', address_village: '' })}>
          <option value="">—</option>
          {groups.map(([region, list]) => (
            <optgroup key={region} label={region}>{list.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}</optgroup>
          ))}
        </select>
      </Field>
      {districts.length > 0 ? (
        <Field label="რაიონი" htmlFor="adist">
          <select id="adist" className="select" value={value.address_district_code} onChange={(e) => set('address_district_code', e.target.value)}>
            <option value="">—</option>{districts.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
          </select>
        </Field>
      ) : (
        <Field label="სოფელი / დაბა" htmlFor="avillage" hint={value.address_unit_code ? 'ქალაქის შემთხვევაში დატოვეთ ცარიელი' : undefined}>
          <input id="avillage" className="input" list="village-list" disabled={!value.address_unit_code} value={value.address_village} onChange={(e) => set('address_village', e.target.value)} />
          <datalist id="village-list">{villages.data?.map((v) => <option key={v} value={v} />)}</datalist>
        </Field>
      )}
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="მისამართი (ქუჩა, სახლი, ბინა)" htmlFor="aline"><input id="aline" className="input" value={value.address_line} onChange={(e) => set('address_line', e.target.value)} /></Field>
      </div>
    </>
  );
}

export const emptyAddress = (): AddressFieldsValue => ({ address_unit_code: '', address_district_code: '', address_village: '', address_line: '', address_country: '' });

/** API-სთვის: ცარიელი ველები → null (განახლებისას ძველი მნიშვნელობის წასაშლელად) */
export const addressPayload = (a: AddressFieldsValue, foreign: boolean) => foreign
  ? { address_unit_code: null, address_district_code: null, address_village: null, address_line: a.address_line || null, address_country: a.address_country || null }
  : { address_unit_code: a.address_unit_code || null, address_district_code: a.address_district_code || null, address_village: a.address_village || null, address_line: a.address_line || null, address_country: null };
