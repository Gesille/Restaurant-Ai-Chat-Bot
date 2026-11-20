/**
 * The restaurant file sync against a REAL MongoDB (validators, indexes, statuses), then discovery of its key.
 * Skipped automatically when MONGODB_TEST_URI is not set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import pino from "pino";
import { runMigrations } from "../../src/db/migrate.js";
import { createRepositories, type Repositories } from "../../src/repositories/index.js";
import { MongoAccountStore } from "../../src/repositories/accountStore.js";
import { ProvisioningService } from "../../src/services/provisioningService.js";
import { syncRestaurant } from "../../src/services/restaurantSync.js";
import { parseRestaurantFile } from "../../src/domain/restaurantFile.js";

const uri = process.env.MONGODB_TEST_URI;
const retention = { RETENTION_MESSAGES_DAYS: 30, RETENTION_CONVERSATIONS_DAYS: 90, RETENTION_USAGE_MONTHS: 13 };

const file = (o: Record<string, unknown> = {}) => {
  const r = parseRestaurantFile({
    name: "Sync Grill", slug: "sync-grill", timezone: "America/Antigua", currency: "XCD",
    owner: { name: "Owner", email: "sync-owner@example.com" },
    origins: ["https://syncgrill.example"],
    settings: { phone: "+1 268 555 0100", address: "1 Beach Rd" },
    hours: { monday: [{ opens: "10:00", closes: "22:00" }] },
    policies: { payment: { title: "Payment", body: "Cash and cards." } },
    faqs: [{ question: "Do you have WiFi?", answer: "Yes.", category: "General" }],
    menu: [
      { name: "Banana Pancakes", category: "Breakfast", price: 18.5, description: "Fluffy", allergens: ["milk"] },
      { name: "Fish Tacos", category: "Lunch", price: 30 },
    ],
    publish: true,
    ...o,
  });
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.file;
};

describe.skipIf(!uri)("restaurant file sync against MongoDB", () => {
  let client: MongoClient;
  let db: Db;
  let repos: Repositories;
  let run: (o?: Record<string, unknown>) => Promise<void>;

  beforeAll(async () => {
    client = new MongoClient(uri!);
    await client.connect();
    db = client.db(`it_sync_${Date.now()}`);
    await runMigrations(db);
    repos = createRepositories(db, retention);
    const store = new MongoAccountStore(repos.cols);
    const provisioning = new ProvisioningService(store, { allowInsecureLocalhostOrigins: false }, pino({ level: "silent" }));
    run = (o) => syncRestaurant(file(o), { store, provisioning, allowInsecureLocalhostOrigins: false, log: () => {}, tenant: (r) => repos.forTenant(r), ownerPassword: "Correct-Horse-Battery-9" });
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  it("creates, re-runs idempotently, updates, archives and moves the key with the origins", async () => {
    await run();
    await run(); // idempotent
    const r = await repos.accounts.findRestaurantBySlug("sync-grill");
    expect(r).not.toBeNull();
    const t = repos.forTenant(r!);
    expect((await t.menu.list()).map((i) => i.slug).sort()).toEqual(["banana-pancakes", "fish-tacos"]);
    expect((await t.knowledge.listPublishedFaqs()).map((f) => f.slug)).toEqual(["do-you-have-wifi"]);
    const key1 = await repos.tenantResolver.discoverWidgetKey("https://syncgrill.example");
    expect(key1).toMatch(/^wk_/);

    await run({ menu: [{ name: "Banana Pancakes", category: "Breakfast", price: 20, allergens: ["milk"] }], faqs: [], origins: ["https://www.syncgrill.example"] });
    expect((await t.menu.findBySlug("banana-pancakes"))?.priceCents).toBe(2000);
    expect((await t.menu.findBySlug("banana-pancakes"))?.description).toBeUndefined();
    expect((await t.menu.findAnyBySlug("fish-tacos"))?.status).toBe("archived");
    expect(await t.knowledge.listPublishedFaqs()).toEqual([]);
    expect(await repos.tenantResolver.discoverWidgetKey("https://syncgrill.example")).toBeNull();
    const key2 = await repos.tenantResolver.discoverWidgetKey("https://www.syncgrill.example");
    expect(key2).toMatch(/^wk_/);
    expect(key2).not.toBe(key1);

    await run(); // back to the original file: restored
    expect((await t.menu.findAnyBySlug("fish-tacos"))?.status).toBe("active");
    expect((await t.knowledge.listPublishedFaqs()).map((f) => f.slug)).toEqual(["do-you-have-wifi"]);
  });
});
