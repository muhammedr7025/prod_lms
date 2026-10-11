import { institutionSettingsContract } from '@exatech/contracts';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Settings' };

export default function Page() {
  return (
    <Prefetch queries={[q(institutionSettingsContract.get, {})]}>
      <SettingsScreen />
    </Prefetch>
  );
}
