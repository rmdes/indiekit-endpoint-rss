import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { dashboardController } from "./lib/controllers/dashboard.js";
import { feedsController } from "./lib/controllers/feeds.js";
import { itemsController } from "./lib/controllers/items.js";
import { statusController } from "./lib/controllers/status.js";
import { startSync, stopSync } from "./lib/sync.js";
import { waitForReady } from "@rmdes/indiekit-startup-gate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const defaults = {
  mountPath: "/rssapi",
  syncInterval: 900_000, // 15 minutes
  maxItemsPerFeed: 50,
  fetchTimeout: 10_000,
  maxConcurrentFetches: 3,
  retentionDays: 30,
  minItemsPerFeed: 10,
  maxPostsPerCycle: 10,
};

export default class RssEndpoint {
  name = "RSS feed reader endpoint";

  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.mountPath = this.options.mountPath;
  }

  get localesDirectory() {
    return path.join(__dirname, "locales");
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "rss.title",
      requiresDatabase: true,
    };
  }

  get shortcutItems() {
    return {
      url: this.options.mountPath,
      name: "rss.feeds",
      iconName: "syndicate",
      requiresDatabase: true,
    };
  }

  /**
   * Protected routes (require authentication)
   * Admin dashboard and feed management (write operations)
   *
   * Built once per instance. Indiekit reads this getter twice while mounting
   * (once to test it, once to pass it to router.use), so a router built on
   * every read registers every handler twice.
   * @returns {express.Router}
   */
  get routes() {
    if (this._routes) return this._routes;

    const router = express.Router();

    // Dashboard
    router.get("/", dashboardController.get);

    // Manual sync trigger
    router.post("/sync", dashboardController.sync);

    // Clear items and re-sync
    router.post("/clear-resync", dashboardController.clearResync);

    // Feed management (protected - requires auth)
    router.post("/api/feeds", express.json(), feedsController.add);
    router.delete("/api/feeds/:id", feedsController.remove);
    router.patch("/api/feeds/:id", express.json(), feedsController.toggle);

    // Manual refresh (protected)
    router.post("/api/refresh", statusController.refresh);

    this._routes = router;
    return router;
  }

  /**
   * Public routes (no authentication required)
   * Read-only JSON API endpoints for frontend
   * @returns {express.Router}
   */
  get routesPublic() {
    if (this._routesPublic) return this._routesPublic;

    const router = express.Router();

    // Feeds API (read-only)
    router.get("/api/feeds", feedsController.list);

    // Items API (read-only)
    router.get("/api/items", itemsController.list);
    router.get("/api/items/:id", itemsController.get);

    // Status API (read-only)
    router.get("/api/status", statusController.status);

    this._routesPublic = router;
    return router;
  }

  init(Indiekit) {
    Indiekit.addEndpoint(this);

    // Add MongoDB collections
    Indiekit.addCollection("rssFeeds");
    Indiekit.addCollection("rssItems");

    // Store config in application for controller access
    Indiekit.config.application.rssConfig = this.options;
    Indiekit.config.application.rssEndpoint = this.mountPath;

    // Store database getter for controller access
    Indiekit.config.application.getRssDb = () => Indiekit.database;

    // Start background sync if database is available
    if (Indiekit.config.application.mongodbUrl) {
      this._stopGate = waitForReady(
        () => startSync(Indiekit, this.options),
        { label: "RSS" },
      );
    }
  }

  destroy() {
    this._stopGate?.();
    stopSync();
  }
}
