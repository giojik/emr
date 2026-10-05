import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** მოდულები და პარამეტრები (0037) — კლინიკის ადმინისტრატორი რთავს / თიშავს */
export interface SystemModule { code: string; name: string; description: string | null; enabled: boolean; settings: Record<string, unknown>; sort_order: number; updated_at: string }
export const useModules = () => useQuery({ queryKey: ['modules'], queryFn: () => api<SystemModule[]>('/modules'), staleTime: 5 * 60_000 });
export const useModuleEnabled = (code: string) => { const q = useModules(); return q.data?.find((m) => m.code === code)?.enabled ?? false; };
