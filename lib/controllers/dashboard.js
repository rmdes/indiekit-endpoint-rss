import { getSyncState, runSync } from "../sync.js";
import { formatFeed, formatItem } from "../utils.js";

/**
 * Extract and clear flash messages from session
 * Returns { success, error } for Indiekit's native notificationBanner
 */
function consumeFlashMessage(request) {
  const result = {};
  if (request.session?.messages?.length) {
    const msg = request.session.messages[0];
    if (msg.type === "success") result.success = msg.content;
    else if (msg.type === "error" || msg.type === "warning")
      result.error = msg.content;
    request.session.messages = null;
  }
  return result;
}

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

      // Extract flash messages for native Indiekit notification banner
      const flash = consumeFlashMessage(request);

      response.render("rss", {
        title: response.__("rss.title"),
        feeds: feeds.map(formatFeed),
        recentItems: recentItems.map((item) => formatItem(item)),
        totalFeeds: feeds.length,
        totalItems,
        syncState: {
          syncing: syncState.syncing,
          lastSync: syncState.lastSync,
          lastError: syncState.lastError,
        },
        mountPath: request.baseUrl,
        publicUrl: rssEndpoint,
        ...flash,
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
        request.session.messages = [
          { type: "error", content: "Not configured" },
        ];
        return response.redirect(request.baseUrl);
      }

      const db = getRssDb?.();
      if (!db) {
        request.session.messages = [
          { type: "error", content: "Database not available" },
        ];
        return response.redirect(request.baseUrl);
      }

      const syncState = getSyncState();
      if (syncState.syncing) {
        request.session.messages = [
          { type: "warning", content: "A sync is already in progress" },
        ];
        return response.redirect(request.baseUrl);
      }

      const result = await runSync(db, rssConfig);

      if (result.error) {
        request.session.messages = [
          { type: "error", content: result.error },
        ];
        return response.redirect(request.baseUrl);
      }

      const itemsAdded = result.itemsAdded || 0;
      const feedsProcessed = result.feedsProcessed || 0;
      const itemsPruned = result.itemsPruned || 0;

      let message;
      if (itemsAdded > 0) {
        message = `Synced ${itemsAdded} new items from ${feedsProcessed} feeds`;
        if (itemsPruned > 0) {
          message += ` (${itemsPruned} old items pruned)`;
        }
      } else {
        message = "Feeds are up to date, nothing new to sync";
      }

      request.session.messages = [
        { type: "success", content: message },
      ];
      response.redirect(request.baseUrl);
    } catch (error) {
      console.error("[RSS] Sync error:", error.message);
      request.session.messages = [
        { type: "error", content: error.message },
      ];
      response.redirect(request.baseUrl);
    }
  },
};
