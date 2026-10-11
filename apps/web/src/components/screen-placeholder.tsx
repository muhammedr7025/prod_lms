'use client';

import { SCREENS, type ScreenKey } from '@exatech/contracts';
import { Card, CardBody, Kicker, Page, PageHeader } from '@exatech/ui';

/** Temporary stand-in while a screen is being implemented. */
export function ScreenPlaceholder({ screen }: { screen: ScreenKey }) {
  const s = SCREENS[screen];
  return (
    <Page label={s.label}>
      <PageHeader kicker="In progress" title={s.label} />
      <Card>
        <Kicker>{s.path}</Kicker>
        <CardBody>This screen is being implemented.</CardBody>
      </Card>
    </Page>
  );
}
