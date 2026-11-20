/* eslint-disable security/detect-non-literal-fs-filename -- operator-only CLI reading local files the operator chose */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { connectMongo } from "../db/mongo.js";
import { getCollections } from "../db/collections.js";
import { runMigrations } from "../db/migrate.js";
import { MongoAccountStore } from "../repositories/accountStore.js";
import { createRepositories } from "../repositories/index.js";
import { ProvisioningService } from "../services/provisioningService.js";
import { syncRestaurant } from "../services/restaurantSync.js";
import { parseRestaurantFile } from "../domain/restaurantFile.js";
import { AppError } from "../errors.js";

/**
 * Syncs restaurant files into the database (the files are the source of truth). Safe to run again.
 *   node dist/scripts/provisionFile.js data/restaurants              # every *.json except example*.json
 *   node dist/scripts/provisionFile.js data/restaurants/big-banana.json
 * deploy/deploy.sh runs it on every deploy.
 */

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string, code = 1): never => {
  process.stderr.write(`${s}\n`);
  return process.exit(code);
};

const args = process.argv.slice(2);
if (args.length === 0) fail("Usage: node dist/scripts/provisionFile.js <dir-or-file.json>...", 2);

async function expand(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  return (await readdir(path))
    .filter((f) => f.endsWith(".json") && !f.startsWith("example"))
    .sort()
    .map((f) => join(path, f));
}

// Validate EVERY file before touching the database: one typo must not leave half the restaurants synced.
const files = (await Promise.all(args.map(expand))).flat();
const parsed = [];
const problems: string[] = [];
for (const f of files) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(f, "utf8"));
  } catch (e) {
    problems.push(`${f}: cannot read/parse: ${(e as Error).message}`);
    continue;
  }
  const r = parseRestaurantFile(raw);
  if (r.ok) parsed.push({ path: f, file: r.file });
  else problems.push(...r.problems.map((p) => `${f}: ${p}`));
}
if (problems.length > 0) fail(`Problems in restaurant files:\n  - ${problems.join("\n  - ")}`);
if (parsed.length === 0) {
  out("no restaurant files to sync");
  process.exit(0);
}

const env = loadEnv();
const database = await connectMongo(env);
try {
  await runMigrations(database.db);
  const logger = pino({ level: env.LOG_LEVEL });
  const store = new MongoAccountStore(getCollections(database.db));
  const allowInsecureLocalhostOrigins = env.NODE_ENV !== "production";
  const provisioning = new ProvisioningService(store, { allowInsecureLocalhostOrigins }, logger);
  const repos = createRepositories(database.db, env);
  const password = process.env.PROVISION_PASSWORD || undefined;

  for (const { path, file } of parsed) {
    out(`== ${basename(path)}`);
    await syncRestaurant(file, {
      store, provisioning, allowInsecureLocalhostOrigins, log: out,
      tenant: (r) => repos.forTenant(r),
      ...(password ? { ownerPassword: password } : {}),
    });
  }
  out("done");
} catch (err) {
  if (err instanceof AppError) fail(`error: ${err.message}`);
  throw err;
} finally {
  await database.close();
}
