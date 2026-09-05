import { applyFeedSettings, rewindWatermark } from "../feed-settings.js";
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


/**
 * Publish context for a request, or null when the site is not configured.
 * @param {object} request - Request
 * @returns {object|null} Micropub endpoint and publication URL
 */
function publishContextFrom(request) {
  const { application, publication } = request.app.locals;

  return application?.micropubEndpoint && publication?.me
    ? { micropubEndpoint: application.micropubEndpoint, me: publication.me }
    : null;
}

/**
 * Record a flash message and return to the dashboard.
 * @param {object} request - Request
 * @param {object} response - Response
 * @param {string} type - success, error or warning
 * @param {string} content - Message
 */
function flashBack(request, response, type, content) {
  request.session.messages = [{ type, content }];
  response.redirect(request.baseUrl);
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
        postTypes: Object.keys(request.app.locals.publication?.postTypes || {}),
        ...flash,
      });
    } catch (error) {
      next(error);
    }
  },


  /**
   * Save a feed's settings from the dashboard form
   * POST /feeds/:id/settings
   */
  async saveFeedSettings(request, response) {
    try {
      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return flashBack(request, response, "error", "Database not available");
      }

      const body = {
        url: request.body.url,
        publish: {
          // An unchecked checkbox is omitted from a form post entirely, so
          // presence is the signal.
          enabled: request.body.enabled !== undefined,
          postType: request.body.postType,
          content: request.body.content,
          linkProperty: request.body.linkProperty || null,
          status: request.body.status,
        },
      };

      const result = await applyFeedSettings(
        db,
        request.params.id,
        body,
        request.app.locals.publication,
      );

      if (result.error) {
        return flashBack(request, response, "error", result.error);
      }

      // Saying "nothing is waiting" beats silence: a feed can be correctly
      // configured and still publish nothing, because the watermark only
      // admits items dated after publishing was switched on.
      const message =
        result.eligible === 0
          ? "Settings saved. No items are waiting — only items published after you enabled this will post. Use Publish existing items to include the ones already cached."
          : result.eligible > 0
            ? `Settings saved. ${result.eligible} item(s) waiting to publish.`
            : "Settings saved.";

      flashBack(request, response, "success", message);
    } catch (error) {
      console.error("[RSS] Error saving feed settings:", error.message);
      flashBack(request, response, "error", error.message);
    }
  },

  /**
   * Rewind a feed's watermark and publish straight away
   * POST /feeds/:id/backfill
   */
  async backfillFeed(request, response) {
    try {
      const { rssConfig, getRssDb } = request.app.locals.application;
      const db = getRssDb?.();
      if (!db) {
        return flashBack(request, response, "error", "Database not available");
      }

      const result = await rewindWatermark(db, request.params.id, {
        last: Number(request.body.last),
      });

      if (result.error) {
        return flashBack(request, response, "error", result.error);
      }

      if (result.eligible === 0) {
        return flashBack(
          request,
          response,
          "warning",
          "Nothing to publish: those items are already published or were skipped after repeated failures.",
        );
      }

      // Run the sync now rather than leaving the user to wait a cycle and
      // guess. This is the only way the answer can be "3 published" instead
      // of "queued, come back later".
      const sync = await runSync(db, rssConfig, publishContextFrom(request));

      if (sync.error) {
        return flashBack(request, response, "error", sync.error);
      }

      const published = sync.itemsPublished || 0;
      flashBack(
        request,
        response,
        published > 0 ? "success" : "warning",
        published > 0
          ? `Published ${published} item(s) from the cache.`
          : `${result.eligible} item(s) became eligible but none published — check the logs for the reason.`,
      );
    } catch (error) {
      console.error("[RSS] Error running backfill:", error.message);
      flashBack(request, response, "error", error.message);
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
      const { application, publication } = request.app.locals;
      const publishContext =
        application?.micropubEndpoint && publication?.me
          ? {
              micropubEndpoint: application.micropubEndpoint,
              me: publication.me,
            }
          : null;
      const result = await runSync(db, rssConfig, publishContext);

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

      const { application, publication } = request.app.locals;
      const publishContext =
        application?.micropubEndpoint && publication?.me
          ? {
              micropubEndpoint: application.micropubEndpoint,
              me: publication.me,
            }
          : null;
      const result = await runSync(db, rssConfig, publishContext);

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
