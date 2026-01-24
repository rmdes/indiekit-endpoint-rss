import { getSyncState, runSync } from "../sync.js";
import { formatFeed, formatItem } from "../utils.js";

export const dashboardController = {
  /**
   * Render admin dashboard
   * GET /
   */
  async get(request, response, next) {
    try {
      const { rssConfig, rssEndpoint } = request.app.locals.application;

      if (!rssConfig) {
        return response.status(500).render("rss", {
          title: response.locals.__("rss.title"),
          error: { message: response.locals.__("rss.error.noConfig") },
        });
      }

      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.render("rss", {
          title: response.locals.__("rss.title"),
          error: { message: response.locals.__("rss.error.noDatabase") },
        });
      }

      const feedsCollection = db.collection("rssFeeds");
      const itemsCollection = db.collection("rssItems");

      // Get feeds and recent items
      const [feeds, recentItems, totalItems] = await Promise.all([
        feedsCollection.find({}).sort({ addedAt: -1 }).toArray(),
        itemsCollection
          .find({})
          .sort({ pubDate: -1 })
          .limit(10)
          .toArray(),
        itemsCollection.countDocuments({}),
      ]);

      const syncState = getSyncState();

      response.render("rss", {
        title: response.locals.__("rss.title"),
        feeds: feeds.map(formatFeed),
        recentItems: recentItems.map((item) => formatItem(item)),
        totalFeeds: feeds.length,
        totalItems,
        syncState: {
          syncing: syncState.syncing,
          lastSync: syncState.lastSync?.toISOString(),
          lastError: syncState.lastError,
        },
        publicUrl: rssEndpoint,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Trigger manual sync
   * POST /sync
   */
  async sync(request, response) {
    try {
      const Indiekit = request.app.locals.indiekit;
      const { rssConfig } = request.app.locals.application;

      if (!Indiekit || !rssConfig) {
        return response.status(500).json({
          error: response.locals.__("rss.error.noConfig"),
        });
      }

      const syncState = getSyncState();
      if (syncState.syncing) {
        return response.status(409).json({
          error: "Sync already in progress",
          syncing: true,
        });
      }

      // Start sync and wait for result
      const result = await runSync(Indiekit, rssConfig);

      if (result.error) {
        return response.status(500).json({
          success: false,
          error: result.error,
        });
      }

      response.json({
        success: true,
        message: response.locals.__("rss.success.syncComplete"),
        feedsProcessed: result.feedsProcessed,
        itemsAdded: result.itemsAdded,
      });
    } catch (error) {
      console.error("[RSS] Sync error:", error.message);
      response.status(500).json({ error: error.message });
    }
  },
};
