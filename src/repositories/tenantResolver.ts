import type { Collections } from "../db/collections.js";
import { restaurantIdSchema, type RestaurantId } from "../domain/ids.js";

export interface ResolvedTenant {
  restaurantId: RestaurantId;
  widgetKeyId: string;
  allowedOrigins: readonly string[];
}

/**
 * The server-side "widget key -> tenant" lookup (spec section 1: the client identifies a widget,
 * the server decides the tenant). This is the ONLY unscoped read in the system, and it only returns
 * a tenant for an active key whose restaurant is active. Inputs are type-checked as plain strings so an
 * object like {"$ne": null} can never reach the query.
 */
export class TenantResolver {
  constructor(private readonly cols: Collections) {}

  async resolveWidgetKey(publicKey: unknown): Promise<ResolvedTenant | null> {
    if (typeof publicKey !== "string" || !/^wk_[A-Za-z0-9_-]{32}$/.test(publicKey)) return null;
    const key = await this.cols.widgetKeys.findOne({ publicKey, status: "active" });
    if (!key) return null;
    const restaurant = await this.cols.restaurants.findOne({ restaurantId: key.restaurantId, status: "active" });
    if (!restaurant) return null;
    return {
      restaurantId: restaurantIdSchema.parse(key.restaurantId),
      widgetKeyId: key._id.toHexString(),
      allowedOrigins: key.allowedOrigins,
    };
  }

  /**
   * Origin -> public widget key, so a site needs no key pasted in (the WordPress plugin calls this on load).
   * The key is public by design (it sits in every page's HTML) and stays bound to the same exact-origin
   * allow-list, so this reveals nothing a visitor of that site could not already read.
   */
  async discoverWidgetKey(origin: unknown): Promise<string | null> {
    if (typeof origin !== "string" || origin.length > 200) return null;
    let normalized: string;
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
      normalized = url.origin;
    } catch {
      return null;
    }
    const keys = await this.cols.widgetKeys
      .find({ allowedOrigins: normalized, status: "active" }, { sort: { createdAt: -1 }, limit: 5 })
      .toArray();
    for (const key of keys) {
      const restaurant = await this.cols.restaurants.findOne({ restaurantId: key.restaurantId, status: "active" });
      if (restaurant) return key.publicKey;
    }
    return null;
  }
}
