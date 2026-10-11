import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_helpers';

/* Better Auth core tables (user, session, account, verification, twoFactor) */

export const user = pgTable(
  'user',
  {
    id: pk(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean().default(false).notNull(),
    image: text(),
    phoneNumber: text().unique(),
    phoneNumberVerified: boolean().default(false),
    twoFactorEnabled: boolean().default(false),
    /** staff | student | guardian */
    kind: text({ enum: ['staff', 'student', 'guardian'] }).default('staff').notNull(),
    /** invite-only: users are created as invited and become active on first sign-in */
    status: text({ enum: ['invited', 'active', 'deactivated'] }).default('invited').notNull(),
    invitedAt: tsz(),
    lastLoginAt: tsz(),
    locale: text().default('en').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.kind)],
);

export const session = pgTable(
  'session',
  {
    id: pk(),
    expiresAt: tsz().notNull(),
    token: text().notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text(),
    userAgent: text(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The membership (role × scope) the user is acting as. */
    activeMembershipId: uuid(),
    /** Selected branch context; null = all branches allowed by the membership. */
    activeBranchId: uuid(),
    /** Set when a Super Admin is viewing as this user. */
    impersonatedBy: uuid(),
    readOnly: boolean().default(false).notNull(),
    lastSeenAt: tsz(),
    /** magic_link | email_otp | phone_otp | google | demo | impersonation */
    authMethod: text(),
    /** Second factor completed for this session (or not required). */
    twoFactorVerified: boolean().default(false).notNull(),
  },
  (t) => [index().on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: pk(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: tsz(),
    refreshTokenExpiresAt: tsz(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: pk(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: tsz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.identifier)],
);

export const twoFactor = pgTable('two_factor', {
  id: pk(),
  secret: text().notNull(),
  backupCodes: text().notNull(),
  userId: uuid()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

/* ───────────────────────── Access: role × scope ───────────────────────── */

export const role = pgTable(
  'role',
  {
    id: pk(),
    institutionId: uuid().notNull(),
    /** superadmin | branchadmin | sales | salesmanager | finance | teacher | student | parent | custom keys */
    key: text().notNull(),
    name: text().notNull(),
    description: text(),
    scopeKind: text({ enum: ['institution', 'branch', 'batch', 'own', 'child'] }).notNull(),
    surface: text({ enum: ['staff', 'portal'] }).notNull(),
    isSystem: boolean().default(false).notNull(),
    /** Granted permission keys, e.g. "finance:payment.collect". Least privilege: new roles start empty. */
    permissions: text().array().default([]).notNull(),
    position: integer().default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.institutionId, t.key)],
);

export const membership = pgTable(
  'membership',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleId: uuid()
      .notNull()
      .references(() => role.id),
    /** Branches this membership covers. Empty = institution-wide (Super Admin). */
    branchIds: uuid().array().default([]).notNull(),
    /** Display scope, e.g. "TVM · own leads", "DM-A · FS-B". */
    scopeLabel: text(),
    status: text({ enum: ['active', 'suspended'] }).default('active').notNull(),
    isDefault: boolean().default(false).notNull(),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId), uniqueIndex().on(t.userId, t.roleId)],
);

/** Staff directory facts that are not part of auth. */
export const staffProfile = pgTable('staff_profile', {
  userId: uuid()
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  homeBranchId: uuid(),
  title: text(),
  employeeCode: text(),
  status: text({ enum: ['active', 'leave', 'inactive'] }).default('active').notNull(),
  /** { [branchId]: weekdays 0-6 } for teachers working across branches. */
  onSiteDays: jsonb().$type<Record<string, number[]>>().default({}).notNull(),
  joinedOn: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
