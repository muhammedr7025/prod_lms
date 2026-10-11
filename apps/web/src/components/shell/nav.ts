import { canSee, NAV_GROUPS, ROLE_HOME, ROLE_NAV, SCREENS, type Me, type ScreenDef, type ScreenKey, type SystemRoleKey } from '@exatech/contracts';

export type NavItem = { kind: 'head'; label: string } | { kind: 'item'; key: ScreenKey; screen: ScreenDef };

/** Sidebar / bottom-nav entries for the active membership (system roles mirror the prototype). */
export function navFor(me: Me): NavItem[] {
  const perms = me.membership.permissions;
  const roleKey = me.membership.roleKey as SystemRoleKey;
  const out: NavItem[] = [];
  if (ROLE_NAV[roleKey]) {
    let pendingHead: string | null = null;
    for (const entry of ROLE_NAV[roleKey]) {
      if (typeof entry === 'object') {
        pendingHead = entry.head;
        continue;
      }
      const screen = SCREENS[entry] as ScreenDef;
      if (!canSee(screen, perms)) continue;
      if (pendingHead) {
        out.push({ kind: 'head', label: pendingHead });
        pendingHead = null;
      }
      out.push({ kind: 'item', key: entry, screen });
    }
    return out;
  }
  // Custom roles: derive from permissions.
  for (const g of NAV_GROUPS) {
    const items = g.keys.filter((k) => canSee(SCREENS[k] as ScreenDef, perms));
    if (items.length === 0) continue;
    out.push({ kind: 'head', label: g.head });
    for (const k of items) out.push({ kind: 'item', key: k, screen: SCREENS[k] as ScreenDef });
  }
  return out;
}

/** Where a membership lands after sign-in or a role switch. */
export function homePath(me: Me): string {
  const roleKey = me.membership.roleKey as SystemRoleKey;
  const home = ROLE_HOME[roleKey];
  if (home && canSee(SCREENS[home] as ScreenDef, me.membership.permissions)) return SCREENS[home].path;
  const first = navFor(me).find((n) => n.kind === 'item');
  return first && first.kind === 'item' ? first.screen.path : '/no-access';
}
