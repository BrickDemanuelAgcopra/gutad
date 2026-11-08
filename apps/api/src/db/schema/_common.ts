import { timestamp, uuid } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().defaultRandom();
export const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());
export const ts = (name: string) => timestamp(name, { withTimezone: true });
