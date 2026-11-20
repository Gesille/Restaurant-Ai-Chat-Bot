/* eslint-disable security/detect-object-injection -- in-memory test fakes indexed by fixed field names */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { syncRestaurant, type SyncDeps, type SyncTenant } from "../src/services/restaurantSync.js";
import { parseRestaurantFile, type RestaurantFile } from "../src/domain/restaurantFile.js";
import type { Restaurant } from "../src/domain/schemas.js";

type Key = { keyId: string; publicKey: string; allowedOrigins: string[]; status: "active" | "revoked"; createdAt: Date };
type Item = { slug: string; name: string; status: "active" | "archived"; allergens: string[]; priceCents: number; description?: string };
type Faq = { slug: string; question: string; answer: string; status: "draft" | "published" | "archived" };
type Policy = { kind: string; title: string; body: string; status: "draft" | "published" };

function fakeWorld() {
  const restaurants = new Map<string, Restaurant>();
  const keys: Key[] = [];
  const menu = new Map<string, Item>();
  const faqs = new Map<string, Faq>();
  const policies = new Map<string, Policy>();
  let hoursSaved = 0;
  let n = 0;
  const log: string[] = [];
  const newKey = (origins: string[]): Key => {
    n += 1;
    const k: Key = { keyId: `k${n}`, publicKey: `wk_${String(n).padStart(32, "0")}`, allowedOrigins: origins, status: "active", createdAt: new Date() };
    keys.push(k);
    return k;
  };
  const page = <T extends { slug: string }>(rows: T[], o: { after?: string; limit: number }) =>
    rows.filter((r) => !o.after || r.slug > o.after).sort((a, b) => a.slug.localeCompare(b.slug)).slice(0, o.limit);

  const tenant: SyncTenant = {
    hours: { replace: async () => { hoursSaved += 1; } },
    menu: {
      findAnyBySlug: async (slug) => (menu.get(slug) ?? null) as never,
      listForAdmin: async (o) => page([...menu.values()].filter((i) => o.status === "all" || i.status === o.status), o) as never,
      create: async (i) => { menu.set(i.slug, { slug: i.slug, name: i.name, status: "active", allergens: [...i.allergens], priceCents: i.priceCents }); },
      update: async (slug, p) => {
        const cur = menu.get(slug)!;
        const changed = Object.entries(p).filter(([k, v]) => k in cur ? (cur as Record<string, unknown>)[k] !== v : v !== null && k !== "available" && k !== "dietaryTags" && k !== "category").map(([k]) => k);
        Object.assign(cur, p.priceCents !== undefined ? { priceCents: p.priceCents } : {}, p.name ? { name: p.name } : {});
        return { item: cur as never, changed };
      },
      setStatus: async (slug, status) => { menu.get(slug)!.status = status; return true; },
    },
    knowledge: {
      listPolicies: async () => [...policies.values()] as never,
      savePolicy: async (kind, p) => {
        const cur = policies.get(kind) ?? { kind, status: "draft" as const, title: "", body: "" };
        const next = { ...cur, ...p };
        policies.set(kind, next);
        return next as never;
      },
      setPolicyStatus: async (kind, status) => { policies.get(kind)!.status = status; return true; },
      listFaqsForAdmin: async (o) => page([...faqs.values()].filter((f) => o.status === "live" ? f.status !== "archived" : true), o) as never,
      findAnyFaqBySlug: async (slug) => (faqs.get(slug) ?? null) as never,
      createFaq: async (f) => { faqs.set(f.slug, { slug: f.slug, question: f.question, answer: f.answer, status: "draft" }); },
      updateFaq: async (slug, p) => {
        const cur = faqs.get(slug)!;
        const changed = (["question", "answer"] as const).filter((k) => p[k] !== undefined && p[k] !== cur[k]);
        Object.assign(cur, { question: p.question ?? cur.question, answer: p.answer ?? cur.answer });
        return { faq: cur as never, changed: [...changed] };
      },
      setFaqStatus: async (slug, status) => { faqs.get(slug)!.status = status; return true; },
    },
  };

  const deps: SyncDeps = {
    allowInsecureLocalhostOrigins: false,
    log: (l) => log.push(l),
    tenant: () => tenant,
    store: {
      findRestaurantBySlug: async (slug) => restaurants.get(slug) ?? null,
      updateRestaurant: async (_id, patch) => {
        const r = [...restaurants.values()][0]!;
        Object.assign(r, patch);
        return r;
      },
      listWidgetKeys: async () => keys.map((k) => ({ ...k })),
      createWidgetKey: async (_id, input) => newKey(input.allowedOrigins),
      revokeWidgetKey: async (_id, keyId) => { keys.find((k) => k.keyId === keyId)!.status = "revoked"; return true; },
    },
    provisioning: {
      provisionRestaurant: async (input) => {
        restaurants.set(input.slug!, {
          restaurantId: "rest_001", slug: input.slug, name: input.name, timezone: input.timezone, currency: input.currency ?? "USD",
          defaultLocale: input.locale ?? "en", status: "active",
        } as unknown as Restaurant);
        const k = input.origins && input.origins.length > 0 ? [newKey(input.origins)] : [];
        return { restaurantId: "rest_001", slug: input.slug!, owner: { userId: "u1", email: input.ownerEmail, created: true, generatedPassword: "pw" }, widgetKeys: k } as never;
      },
      updateSettings: async () => ({ restaurantId: "rest_001", changed: ["phone"] }) as never,
    },
  };
  return { deps, keys, menu, faqs, policies, log, restaurants, hoursSaved: () => hoursSaved };
}

const base = (o: Partial<Record<string, unknown>> = {}): RestaurantFile => {
  const r = parseRestaurantFile({
    name: "Big Banana", slug: "big-banana", timezone: "America/Antigua", currency: "XCD",
    owner: { name: "Owner", email: "owner@example.com" },
    origins: ["https://bigbanana.example"],
    settings: { phone: "+1 268 555 0100" },
    hours: { monday: [{ opens: "10:00", closes: "22:00" }] },
    policies: { payment: { title: "Payment", body: "Cash and cards." } },
    faqs: [{ question: "Do you have WiFi?", answer: "Yes." }],
    menu: [
      { name: "Banana Pancakes", category: "Breakfast", price: 18.5, allergens: ["milk"] },
      { name: "Fish Tacos", category: "Lunch", price: 30 },
    ],
    publish: true,
    ...o,
  });
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.file;
};

describe("restaurant file sync", () => {
  it("first run creates restaurant, key, menu, published FAQs and policies", async () => {
    const w = fakeWorld();
    await syncRestaurant(base(), w.deps);
    expect(w.restaurants.has("big-banana")).toBe(true);
    expect(w.keys.filter((k) => k.status === "active").map((k) => k.allowedOrigins)).toEqual([["https://bigbanana.example"]]);
    expect([...w.menu.keys()].sort()).toEqual(["banana-pancakes", "fish-tacos"]);
    expect(w.menu.get("banana-pancakes")!.priceCents).toBe(1850);
    expect([...w.faqs.values()].map((f) => f.status)).toEqual(["published"]);
    expect(w.policies.get("payment")!.status).toBe("published");
    expect(w.hoursSaved()).toBe(1);
  });

  it("second identical run changes nothing important and keeps the same key", async () => {
    const w = fakeWorld();
    await syncRestaurant(base(), w.deps);
    const key = w.keys[0]!.publicKey;
    await syncRestaurant(base(), w.deps);
    expect(w.keys.filter((k) => k.status === "active").map((k) => k.publicKey)).toEqual([key]);
    expect(w.menu.size).toBe(2);
  });

  it("edits update, removals archive, re-adding restores", async () => {
    const w = fakeWorld();
    await syncRestaurant(base(), w.deps);
    await syncRestaurant(base({ menu: [{ name: "Banana Pancakes", category: "Breakfast", price: 20, allergens: ["milk"] }], faqs: [] }), w.deps);
    expect(w.menu.get("banana-pancakes")!.priceCents).toBe(2000);
    expect(w.menu.get("fish-tacos")!.status).toBe("archived");
    expect(w.faqs.get("do-you-have-wifi")!.status).toBe("archived");
    await syncRestaurant(base(), w.deps);
    expect(w.menu.get("fish-tacos")!.status).toBe("active");
    expect(w.faqs.get("do-you-have-wifi")!.status).toBe("published");
  });

  it("changing origins issues a new key and revokes the old one", async () => {
    const w = fakeWorld();
    await syncRestaurant(base(), w.deps);
    await syncRestaurant(base({ origins: ["https://bigbanana.example", "https://www.bigbanana.example"] }), w.deps);
    const active = w.keys.filter((k) => k.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.allowedOrigins.sort()).toEqual(["https://bigbanana.example", "https://www.bigbanana.example"]);
    expect(w.keys.filter((k) => k.status === "revoked")).toHaveLength(1);
  });

  it("publish:false keeps FAQs/policies as drafts and un-publishes removed policies", async () => {
    const w = fakeWorld();
    await syncRestaurant(base(), w.deps);
    await syncRestaurant(base({ publish: false, policies: {} }), w.deps);
    expect(w.faqs.get("do-you-have-wifi")!.status).toBe("draft");
    expect(w.policies.get("payment")!.status).toBe("draft");
  });

  it("never changes allergens of an existing item (safety data), only warns", async () => {
    const w = fakeWorld();
    await syncRestaurant(base(), w.deps);
    await syncRestaurant(base({ menu: [{ name: "Banana Pancakes", category: "Breakfast", price: 18.5, allergens: ["milk", "eggs"] }, { name: "Fish Tacos", category: "Lunch", price: 30 }] }), w.deps);
    expect(w.menu.get("banana-pancakes")!.allergens).toEqual(["milk"]);
    expect(w.log.some((l) => l.includes("allergens differ"))).toBe(true);
  });

  it("rejects invalid origins before writing anything", async () => {
    const w = fakeWorld();
    await expect(syncRestaurant(base({ origins: ["http://insecure.example"] }), w.deps)).rejects.toThrow(/Invalid origin/);
    expect(w.restaurants.size).toBe(0);
  });
});

describe("data/restaurants files", () => {
  const dir = join(import.meta.dirname, "..", "data", "restaurants");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it.each(files)("%s is a valid restaurant file", (f) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo folder
    const r = parseRestaurantFile(JSON.parse(readFileSync(join(dir, f), "utf8")));
    expect(r.ok ? [] : r.problems).toEqual([]);
  });
});
