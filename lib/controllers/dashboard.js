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
          title: response.__("rss.title"),
          configError: response.__("rss.error.noConfig"),
        });
      }

      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.render("rss", {
          title: response.__("rss.title"),
          configError: response.__("rss.error.noDatabase"),
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
        title: response.__("rss.title"),
        feeds: feeds.map(formatFeed),
        recentItems: recentItems.map((item) => formatItem(item)),
        totalFeeds: feeds.length,
        totalItems,
        syncState: {
          syncing: syncState.syncing,
          lastSync: syncState.lastSync?.toISOString(),
          lastError: syncState.lastError,
        },
        mountPath: request.baseUrl,
        publicUrl: rssEndpoint,
        synced: request.query.synced,
        syncedFeeds: request.query.feeds,
        syncedItems: request.query.items,
        syncInProgress: request.query.syncing,
        queryError: request.query.error,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Clear all items and re-sync
   * POST /clear-resync
   */
  async clearResync(request, response) {
    try {
      const { rssConfig, getRssDb } = request.app.locals.application;

      if (!rssConfig) {
        return response.status(500).json({
          error: response.locals.__("rss.error.noConfig"),
        });
      }

      const db = getRssDb?.();
      if (!db) {
        return response.status(500).json({
          error: response.locals.__("rss.error.noDatabase"),
        });
      }

      // Drop all items
      const itemsCollection = db.collection("rssItems");
      const deleteResult = await itemsCollection.deleteMany({});
      console.log(`[RSS] Cleared ${deleteResult.deletedCount} items`);

      // Reset feed item counts
      const feedsCollection = db.collection("rssFeeds");
      await feedsCollection.updateMany({}, { $set: { itemCount: 0 } });

      // Trigger sync
      const result = await runSync(db, rssConfig);

      if (result.error) {
        return response.status(500).json({
          success: false,
          error: result.error,
        });
      }

      response.json({
        success: true,
        message: response.locals.__("rss.success.clearResync"),
        itemsCleared: deleteResult.deletedCount,
        feedsProcessed: result.feedsProcessed,
        itemsAdded: result.itemsAdded,
      });
    } catch (error) {
      console.error("[RSS] Clear & re-sync error:", error.message);
      response.status(500).json({ error: error.message });
    }
  },

  /**
   * Trigger manual sync
   * POST /sync
   */
  async sync(request, response) {
    try {
      const { rssConfig, getRssDb } = request.app.locals.application;

      if (!rssConfig) {
        return response.redirect(
          request.baseUrl + "?error=" + encodeURIComponent("Not configured"),
        );
      }

      const db = getRssDb?.();
      if (!db) {
        return response.redirect(
          request.baseUrl +
            "?error=" +
            encodeURIComponent("Database not available"),
        );
      }

      const syncState = getSyncState();
      if (syncState.syncing) {
        return response.redirect(request.baseUrl + "?syncing=true");
      }

      const result = await runSync(db, rssConfig);

      if (result.error) {
        return response.redirect(
          request.baseUrl + "?error=" + encodeURIComponent(result.error),
        );
      }

      const params = new URLSearchParams({
        synced: "true",
        feeds: result.feedsProcessed || 0,
        items: result.itemsAdded || 0,
      });
      response.redirect(request.baseUrl + "?" + params.toString());
    } catch (error) {
      console.error("[RSS] Sync error:", error.message);
      response.redirect(
        request.baseUrl + "?error=" + encodeURIComponent(error.message),
      );
    }
  },
};
