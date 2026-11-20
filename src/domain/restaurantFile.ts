import { z } from "zod";
import { ALLERGENS, DIETARY_TAGS, POLICY_KINDS } from "./schemas.js";

/**
 * One restaurant = one JSON file in data/restaurants/. The file is the source of truth:
 * every deploy syncs it into the database (see services/restaurantSync.ts).
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, e.g. 09:30");
const period = z.strictObject({ opens: hhmm, closes: hhmm });
export const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export const restaurantFileSchema = z.strictObject({
  name: z.string().min(1),
  slug: z.string().optional(),
  timezone: z.string().min(1),
  currency: z.string().default("USD"),
  locale: z.string().default("en"),
  owner: z.strictObject({ name: z.string().min(1), email: z.string().min(1) }),
  /** Exact website origins (https://site.com and https://www.site.com are different). The plugin is found by these. */
  origins: z.array(z.string()).default([]),
  settings: z
    .strictObject({
      address: z.string().optional(),
      phone: z.string().optional(),
      mapUrl: z.string().optional(),
      notes: z.string().optional(),
      monthlyAiBudgetUsd: z.number().min(0).optional(),
    })
    .default({}),
  hours: z
    .strictObject(Object.fromEntries(DAYS.map((d) => [d, z.array(period).max(4).optional()])) as Record<(typeof DAYS)[number], z.ZodOptional<z.ZodArray<typeof period>>>)
    .optional(),
  holidays: z
    .array(z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), closed: z.boolean().default(true), periods: z.array(period).max(4).default([]), note: z.string().max(200).optional() }))
    .default([]),
  policies: z.partialRecord(z.enum(POLICY_KINDS), z.strictObject({ title: z.string().min(1), body: z.string().min(1) })).default({}),
  faqs: z
    .array(z.strictObject({ slug: z.string().optional(), question: z.string().min(1), answer: z.string().min(1), category: z.string().optional(), keywords: z.array(z.string()).default([]) }))
    .default([]),
  menu: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        category: z.string().min(1),
        price: z.number().min(0),
        available: z.boolean().default(true),
        dietaryTags: z.array(z.enum(DIETARY_TAGS)).default([]),
        allergens: z.array(z.enum(ALLERGENS)).default([]),
      }),
    )
    .default([]),
  /** false (default): FAQs and policies are saved as drafts and the AI cannot see them. true: publish them. */
  publish: z.boolean().default(false),
});

export type RestaurantFile = z.infer<typeof restaurantFileSchema>;

/** Template placeholders like "" are treated as "not filled in". */
function dropBlank(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropBlank);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "").map(([k, x]) => [k, dropBlank(x)]));
  }
  return v;
}

export function parseRestaurantFile(raw: unknown): { ok: true; file: RestaurantFile } | { ok: false; problems: string[] } {
  const parsed = restaurantFileSchema.safeParse(dropBlank(raw));
  if (parsed.success) return { ok: true, file: parsed.data };
  return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`) };
}
