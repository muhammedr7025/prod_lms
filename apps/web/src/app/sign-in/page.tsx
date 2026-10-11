import { publicContract } from '@exatech/contracts';
import { callApi } from '@/lib/api';
import { SignInForm } from './sign-in-form';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

const API_URL = process.env.API_URL ?? 'http://localhost:4300';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string; error?: string }> }) {
  const sp = await searchParams;
  const config = await callApi(publicContract.config, {}, { baseUrl: API_URL }).catch(() => null);
  const branches = config?.branches ?? [];
  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2">
      <div className="hidden lg:flex bg-accent-100 p-10 flex-col justify-between border-r border-divider">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-accent grid place-items-center text-white font-heading font-semibold text-lg">E</div>
          <div className="font-heading font-semibold text-[22px] tracking-[0.06em]">EXATECH</div>
        </div>
        <div className="relative border border-divider p-7 bg-white">
          <i className="corner tl" />
          <i className="corner tr" />
          <i className="corner bl" />
          <i className="corner br" />
          <div className="text-[10px] tracking-[0.1em] uppercase text-accent">Institution management platform</div>
          <h1 className="text-[40px] mt-1.5 mb-2.5">Enquiry to completion, on one system.</h1>
          <p className="m-0 text-neutral-700 max-w-[46ch]">
            Leads, admissions, fees, timetables, attendance, marks and fee-gated notes — every role sees exactly what it is allowed to, scoped to its branch and batch.
          </p>
          <div className="grid grid-cols-3 gap-3 mt-[22px]">
            <Kpi value={String(branches.length || 3)} label="Branches" />
            <Kpi value={(config?.activeStudents ?? 0).toLocaleString('en-IN')} label="Active students" />
            <Kpi value={String(config?.roles ?? 8)} label="Roles" />
          </div>
        </div>
        <div className="text-xs text-neutral-600">
          {config?.institution ?? 'Exatech'} · {branches.map((b) => b.name).join(' · ') || 'Trivandrum · Kochi · Calicut'}
        </div>
      </div>
      <div className="p-6 sm:p-10 grid place-items-center">
        <SignInForm next={sp.next ?? '/'} reason={sp.reason ?? null} googleEnabled={!!config?.googleEnabled} demoMode={!!config?.demoMode} apiDown={!config} />
      </div>
    </div>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-t-2 border-accent pt-2">
      <div className="font-heading font-semibold text-[26px] leading-none">{value}</div>
      <div className="text-xs text-neutral-600">{label}</div>
    </div>
  );
}
