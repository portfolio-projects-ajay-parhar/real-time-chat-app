import { randomUUID } from "node:crypto";

/**
 * cuid-style sortable id without adding a dependency:
 * timestamp-prefixed + random suffix. Used for storage keys; Prisma models
 * use @default(cuid()) server-side.
 */
export function createId(): string {
  return `f${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
