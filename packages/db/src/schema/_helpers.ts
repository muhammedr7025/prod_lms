import { bigint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/** UUID v7 primary key (time-ordered, index-friendly). */
export const pk = () => uuid().primaryKey().$defaultFn(() => uuidv7());

export const createdAt = () => timestamp({ withTimezone: true }).defaultNow().notNull();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

/** Money in integer paise. */
export const money = () => bigint({ mode: 'number' });

export const tsz = () => timestamp({ withTimezone: true });

export { uuidv7 };
