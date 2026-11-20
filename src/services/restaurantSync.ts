import type { AccountStore } from "../repositories/accountStore.js";
import type { HoursRepository } from "../repositories/hoursRepository.js";
import type { KnowledgeRepository } from "../repositories/knowledgeRepository.js";
import type { MenuRepository } from "../repositories/menuRepository.js";
import type { ProvisioningService } from "./provisioningService.js";
import { DAYS, type RestaurantFile } from "../domain/restaurantFile.js";
import { POLICY_KINDS, type Restaurant } from "../domain/schemas.js";
import { normalizeOrigin, slugify } from "../domain/slug.js";
import { AppError } from "../errors.js";

/**
 * Makes the database match one restaurant file (data/restaurants/*.json): the file is the source of truth.
 *  - restaurant + owner + widget key are created when missing; name/timezone/locale follow the file
 *  - the active widget key's origins follow `origins` (a changed list => new key, old keys revoked)
 *  - menu items and FAQs are created or updated; ones removed from the file are archived (never deleted)
 *  - policies are saved; ones removed from the file go back to draft (invisible to the AI)
 *  - FAQs and policies are published only when `publish: true`
 *  - allergens are set on creation only and always UNVERIFIED: a person must verify them in the API.
 * Safe to run on every deploy.
 */

export interface SyncTenant {
  hours: Pick<HoursRepository, "replace">;
  menu: Pick<MenuRepository, "findAnyBySlug" | "listForAdmin" | "create" | "update" | "setStatus">;
  knowledge: Pick<
    KnowledgeRepository,
    "listPolicies" | "savePolicy" | "setPolicyStatus" | "listFaqsForAdmin" | "findAnyFaqBySlug" | "createFaq" | "updateFaq" | "setFaqStatus"
  >;
}

export interface SyncDeps {
  store: Pick<AccountStore, "findRestaurantBySlug" | "updateRestaurant" | "listWidgetKeys" | "createWidgetKey" | "revokeWidgetKey">;
  provisioning: Pick<ProvisioningService, "provisionRestaurant" | "updateSettings">;
  tenant: (restaurant: Restaurant) => SyncTenant;
  allowInsecureLocalhostOrigins: boolean;
  log: (line: string) => void;
  now?: () => Date;
  /** Set by tests only: password for a newly created owner. */
  ownerPassword?: string;
}

const PAGE = 100;

async function allPages<T extends { slug: string }>(fetch: (after: string | undefined) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after);
    out.push(...page);
    if (page.length < PAGE) return out;
    after = page[page.length - 1]!.slug;
  }
}

const itemSlug = (explicit: string | undefined, fallback: string) => (explicit ?? slugify(fallback)).slice(0, 80).replace(/-+$/, "");
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export async function syncRestaurant(cfg: RestaurantFile, deps: SyncDeps): Promise<void> {
  const { store, provisioning, log } = deps;
  const now = deps.now ?? (() => new Date());
  const slug = cfg.slug ?? slugify(cfg.name);
  if (!slug) throw new AppError(400, "invalid_slug", "slug is required when the name has no Latin letters");

  const origins = [...new Set(cfg.origins.map((o) => {
    const n = normalizeOrigin(o, deps.allowInsecureLocalhostOrigins);
    if (!n) throw new AppError(400, "invalid_origin", `Invalid origin "${o.slice(0, 80)}": use a bare https origin such as https://example.com`);
    return n;
  }))];

  // 1) restaurant + owner (+ first widget key)
  let restaurant = await store.findRestaurantBySlug(slug);
  if (!restaurant) {
    const r = await provisioning.provisionRestaurant({
      name: cfg.name, slug, timezone: cfg.timezone, currency: cfg.currency, locale: cfg.locale,
      ownerEmail: cfg.owner.email, ownerName: cfg.owner.name, origins,
      ...(deps.ownerPassword ? { ownerPassword: deps.ownerPassword } : {}),
    });
    log(`restaurant: ${r.restaurantId} (slug: ${r.slug}) created`);
    log(`owner:      ${r.owner.email} (${r.owner.created ? "created" : "existing user attached, password unchanged"})`);
    if (r.owner.generatedPassword) log(`password:   ${r.owner.generatedPassword}   <- shown once, store it now`);
    restaurant = await store.findRestaurantBySlug(slug);
    if (!restaurant) throw new AppError(500, "internal", "restaurant not found after creation");
  } else {
    const patch = {
      ...(restaurant.name !== cfg.name ? { name: cfg.name } : {}),
      ...(restaurant.timezone !== cfg.timezone ? { timezone: cfg.timezone } : {}),
      ...(restaurant.defaultLocale !== cfg.locale ? { defaultLocale: cfg.locale } : {}),
    };
    if (Object.keys(patch).length > 0) {
      await store.updateRestaurant(restaurant.restaurantId, patch, now());
      log(`restaurant: ${slug} updated (${Object.keys(patch).join(", ")})`);
    } else {
      log(`restaurant: ${slug} up to date`);
    }
    if (restaurant.currency !== cfg.currency) log(`WARNING:    currency is ${restaurant.currency} in the database; it cannot be changed by the file`);
  }
  const rest = restaurant;

  // 2) widget key origins
  const active = (await store.listWidgetKeys(rest.restaurantId)).filter((k) => k.status === "active");
  const keep = origins.length > 0 ? active.find((k) => sameSet(k.allowedOrigins, origins)) : undefined;
  let keyToKeep = keep?.keyId;
  if (origins.length > 0 && !keep) {
    const created = await store.createWidgetKey(rest.restaurantId, { allowedOrigins: origins, label: "sync" }, now());
    keyToKeep = created.keyId;
    log(`widget key: ${created.publicKey} origins: ${origins.join(", ")}`);
  }
  for (const k of active) {
    if (k.keyId === keyToKeep) continue;
    await store.revokeWidgetKey(rest.restaurantId, k.keyId, now());
    log(`widget key: revoked old key for ${k.allowedOrigins.join(", ") || "(no origins)"}`);
  }
  if (origins.length === 0) log("WARNING:    no origins in the file: the chat is disabled on every website");

  // 3) settings (address, phone, map, notes, AI budget)
  const s = cfg.settings;
  if (s.address || s.phone || s.mapUrl || s.notes || s.monthlyAiBudgetUsd !== undefined) {
    const r = await provisioning.updateSettings({
      restaurantSlug: slug,
      ...(s.address ? { address: s.address } : {}), ...(s.phone ? { phone: s.phone } : {}),
      ...(s.mapUrl ? { mapUrl: s.mapUrl } : {}), ...(s.notes ? { notes: s.notes } : {}),
      ...(s.monthlyAiBudgetUsd !== undefined ? { monthlyAiBudgetUsd: s.monthlyAiBudgetUsd } : {}),
    });
    if (r.changed.length > 0) log(`settings:   ${r.changed.join(", ")}`);
  }

  const t = deps.tenant(rest);

  // 4) opening hours (a day with no periods is closed)
  if (cfg.hours) {
    const hours = cfg.hours;
    // eslint-disable-next-line security/detect-object-injection -- d comes from the fixed DAYS list
    await t.hours.replace({ weekly: DAYS.map((d, day) => ({ day, periods: hours[d] ?? [] })), exceptions: cfg.holidays }, now());
    log("hours:      saved");
  }

  // 5) policies
  const wanted = cfg.publish ? "published" : "draft";
  const existingPolicies = new Map((await t.knowledge.listPolicies()).map((p) => [p.kind, p]));
  for (const kind of POLICY_KINDS) {
    // eslint-disable-next-line security/detect-object-injection -- kind comes from the fixed POLICY_KINDS list
    const p = cfg.policies[kind];
    const current = existingPolicies.get(kind);
    if (p) {
      const saved = await t.knowledge.savePolicy(kind, p, now());
      if (saved.status !== wanted) await t.knowledge.setPolicyStatus(kind, wanted, now());
      log(`policy:     ${kind} (${wanted})`);
    } else if (current && current.status === "published") {
      await t.knowledge.setPolicyStatus(kind, "draft", now());
      log(`policy:     ${kind} removed from file -> draft`);
    }
  }

  // 6) FAQs
  const faqSlugs = new Set<string>();
  for (const f of cfg.faqs) {
    const fslug = itemSlug(f.slug, f.question);
    if (!fslug) { log(`faq:        SKIPPED "${f.question.slice(0, 40)}" (add a "slug")`); continue; }
    faqSlugs.add(fslug);
    const current = await t.knowledge.findAnyFaqBySlug(fslug);
    let status = current?.status;
    if (!current) {
      await t.knowledge.createFaq({ slug: fslug, question: f.question, answer: f.answer, keywords: f.keywords, ...(f.category ? { category: f.category } : {}) }, now());
      status = "draft";
      log(`faq:        ${fslug} created`);
    } else {
      const r = await t.knowledge.updateFaq(fslug, { question: f.question, answer: f.answer, keywords: f.keywords, category: f.category ?? null }, now());
      if (r && r.changed.length > 0) log(`faq:        ${fslug} updated (${r.changed.join(", ")})`);
    }
    if (status !== wanted) await t.knowledge.setFaqStatus(fslug, wanted, now());
  }
  const liveFaqs = await allPages((after) => t.knowledge.listFaqsForAdmin({ status: "live", limit: PAGE, ...(after ? { after } : {}) }));
  for (const f of liveFaqs) {
    if (faqSlugs.has(f.slug)) continue;
    await t.knowledge.setFaqStatus(f.slug, "archived", now());
    log(`faq:        ${f.slug} removed from file -> archived`);
  }

  // 7) menu
  const menuSlugs = new Set<string>();
  for (const m of cfg.menu) {
    const mslug = itemSlug(m.slug, m.name);
    if (!mslug) { log(`menu:       SKIPPED "${m.name}" (add a "slug")`); continue; }
    menuSlugs.add(mslug);
    const priceCents = Math.round(m.price * 100);
    const current = await t.menu.findAnyBySlug(mslug);
    if (!current) {
      await t.menu.create({
        slug: mslug, name: m.name, category: m.category, priceCents, currency: rest.currency,
        status: "active", available: m.available, dietaryTags: m.dietaryTags, allergens: m.allergens, allergensVerified: false,
        ...(m.description ? { description: m.description } : {}),
      }, now());
      log(`menu:       ${mslug} created`);
      continue;
    }
    if (current.status === "archived") {
      await t.menu.setStatus(mslug, "active", now());
      log(`menu:       ${mslug} restored`);
    }
    const r = await t.menu.update(mslug, {
      name: m.name, category: m.category, priceCents, available: m.available, dietaryTags: m.dietaryTags,
      description: m.description ?? null,
    }, now());
    if (r && r.changed.length > 0) log(`menu:       ${mslug} updated (${r.changed.join(", ")})`);
    if (!sameSet(current.allergens, m.allergens)) {
      log(`WARNING:    ${mslug}: allergens differ from the file; allergens are safety data and change only through the verified API`);
    }
  }
  const activeItems = await allPages((after) => t.menu.listForAdmin({ status: "active", limit: PAGE, ...(after ? { after } : {}) }));
  for (const item of activeItems) {
    if (menuSlugs.has(item.slug)) continue;
    await t.menu.setStatus(item.slug, "archived", now());
    log(`menu:       ${item.slug} removed from file -> archived`);
  }
}
