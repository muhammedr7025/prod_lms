'use client';

import { Card, CardBody, CardTitle, Kicker, Page } from '@exatech/ui';
import Link from 'next/link';
import { useMe } from './me-context';
import { homePath } from './shell/nav';

export function NoAccess({ screenLabel }: { screenLabel: string }) {
  const me = useMe();
  return (
    <Page label="No access">
      <Card className="max-w-[560px]">
        <Kicker>Access = role × scope</Kicker>
        <CardTitle>{screenLabel} is not part of your {me.membership.roleLabel} membership</CardTitle>
        <CardBody>
          Switch membership from the account menu if you hold another role, or ask a Super Admin to grant the permission. <Link href={homePath(me)}>Go to your home</Link>
        </CardBody>
      </Card>
    </Page>
  );
}
