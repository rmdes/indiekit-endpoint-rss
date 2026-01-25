import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { dashboardController } from "./lib/controllers/dashboard.js";
import { feedsController } from "./lib/controllers/feeds.js";
import { itemsController } from "./lib/controllers/items.js";
import { statusController } from "./lib/controllers/status.js";
import { startSync } from "./lib/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const protectedRouter = express.Router();
const publicRouter = express.Router();

const defaults = {
  mountPath: "/rssapi",
  syncInterval: 900_000, // 15 minutes
  maxItemsPerFeed: 50,
  fetchTimeout: 10_000,
  maxConcurrentFetches: 3,
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
   */
  get routes() {
    // Dashboard
    protectedRouter.get("/", dashboardController.get);

    // Manual sync trigger
    protectedRouter.post("/sync", dashboardController.sync);

    // Clear items and re-sync
    protectedRouter.post("/clear-resync", dashboardController.clearResync);

    // Feed management (protected - requires auth)
    protectedRouter.post("/api/feeds", express.json(), feedsController.add);
    protectedRouter.delete("/api/feeds/:id", feedsController.remove);
    protectedRouter.patch("/api/feeds/:id", express.json(), feedsController.toggle);

    // Manual refresh (protected)
    protectedRouter.post("/api/refresh", statusController.refresh);

    return protectedRouter;
  }

  /**
   * Public routes (no authentication required)
   * Read-only JSON API endpoints for frontend
   */
  get routesPublic() {
    // Feeds API (read-only)
    publicRouter.get("/api/feeds", feedsController.list);

    // Items API (read-only)
    publicRouter.get("/api/items", itemsController.list);
    publicRouter.get("/api/items/:id", itemsController.get);

    // Status API (read-only)
    publicRouter.get("/api/status", statusController.status);

    return publicRouter;
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
      startSync(Indiekit, this.options);
    }
  }
}
