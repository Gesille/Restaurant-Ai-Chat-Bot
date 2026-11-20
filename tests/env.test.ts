import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const prod = (extra: Record<string, string>) =>
  ({ NODE_ENV: "production", MONGODB_DB_NAME: "restaurant_ai", TRUST_PROXY_HOPS: "1", ...extra }) as NodeJS.ProcessEnv;

describe("production MongoDB guard", () => {
  it("accepts Atlas SRV and tls=true URIs", () => {
    expect(() => loadEnv(prod({ MONGODB_URI: "mongodb+srv://u:p@cluster0.abc.mongodb.net/" }))).not.toThrow();
    expect(() => loadEnv(prod({ MONGODB_URI: "mongodb://u:p@db.example.com:27017/?tls=true" }))).not.toThrow();
  });

  it("rejects a non-TLS internet host", () => {
    expect(() => loadEnv(prod({ MONGODB_URI: "mongodb://u:p@db.example.com:27017" }))).toThrow(/must use TLS/);
  });

  it("rejects a private Docker host without the explicit opt-in", () => {
    expect(() => loadEnv(prod({ MONGODB_URI: "mongodb://u:p@mongo:27017/?authSource=admin" }))).toThrow(/must use TLS/);
  });

  it("accepts a private Docker host with MONGODB_PRIVATE_NETWORK=true", () => {
    const env = loadEnv(prod({ MONGODB_URI: "mongodb://u:p@mongo:27017/?authSource=admin", MONGODB_PRIVATE_NETWORK: "true" }));
    expect(env.MONGODB_PRIVATE_NETWORK).toBe(true);
  });

  it("MONGODB_PRIVATE_NETWORK never exempts internet hosts or IPs", () => {
    for (const uri of [
      "mongodb://u:p@db.example.com:27017",
      "mongodb://u:p@72.167.148.252:27017",
      "mongodb://u:p@mongo:27017,db.example.com:27017",
    ]) {
      expect(() => loadEnv(prod({ MONGODB_URI: uri, MONGODB_PRIVATE_NETWORK: "true" }))).toThrow(/single-label private hosts/);
    }
  });

  it("still rejects localhost in production even with the opt-in", () => {
    expect(() => loadEnv(prod({ MONGODB_URI: "mongodb://u:p@localhost:27017", MONGODB_PRIVATE_NETWORK: "true" }))).toThrow(
      /localhost/,
    );
  });
});
