import { getSyncState, runSync } from "../sync.js";

export const statusController = {
  /**
   * Get sync status
   * GET /api/status
   */
  async status(request, response) {
    try {
      const db = request.app.locals.application.getRssDb?.();
      const syncState = getSyncState();
      const { rssConfig } = request.app.locals.application;

      let feedsCount = 0;
      let itemsCount = 0;
      let enabledFeedsCount = 0;

      if (db) {
        const feedsCollection = db.collection("rssFeeds");
        const itemsCollection = db.collection("rssItems");

        feedsCount = await feedsCollection.countDocuments({});
        enabledFeedsCount = await feedsCollection.countDocuments({ enabled: true });
        itemsCount = await itemsCollection.countDocuments({});
      }

      const syncIntervalMs = rssConfig?.syncInterval || 900_000;
      const nextSync = syncState.lastSync
        ? new Date(new Date(syncState.lastSync).getTime() + syncIntervalMs).toISOString()
        : null;

      response.json({
        status: syncState.syncing ? "syncing" : "idle",
        lastSync: syncState.lastSync || null,
        nextSync: nextSync,
        lastError: syncState.lastError,
        stats: {
          feedsCount,
          enabledFeedsCount,
          itemsCount,
          lastFeedsProcessed: syncState.feedsProcessed,
          lastItemsAdded: syncState.itemsAdded,
        },
        config: {
          syncInterval: syncIntervalMs,
          maxItemsPerFeed: rssConfig?.maxItemsPerFeed || 50,
        },
      });
    } catch (error) {
      console.error("[RSS] Error getting status:", error.message);
      response.status(500).json({ error: error.message });
    }
  },

  /**
   * Trigger manual sync
   * POST /api/refresh
   */
  async refresh(request, response) {
    try {
      const Indiekit = request.app.locals.indiekit;
      const { rssConfig } = request.app.locals.application;

      if (!Indiekit || !rssConfig) {
        return response.status(500).json({ error: "Plugin not configured" });
      }

      const syncState = getSyncState();
      if (syncState.syncing) {
        return response.status(409).json({
          error: "Sync already in progress",
          status: "syncing",
        });
      }

      // Run sync asynchronously
      runSync(Indiekit, rssConfig).catch((err) => {
        console.error("[RSS] Manual sync error:", err.message);
      });

      response.json({
        message: response.locals.__("rss.syncing"),
        status: "started",
      });
    } catch (error) {
      console.error("[RSS] Error triggering refresh:", error.message);
      response.status(500).json({ error: error.message });
    }
  },
};
