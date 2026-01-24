import { ObjectId } from "mongodb";
import { RssClient } from "../rss-client.js";
import { formatFeed, isValidUrl, normalizeUrl } from "../utils.js";

export const feedsController = {
  /**
   * List all feeds
   * GET /api/feeds
   */
  async list(request, response) {
    try {
      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.status(500).json({ error: "Database not available" });
      }

      const feedsCollection = db.collection("rssFeeds");
      const feeds = await feedsCollection
        .find({})
        .sort({ addedAt: -1 })
        .toArray();

      response.json({
        feeds: feeds.map(formatFeed),
        total: feeds.length,
      });
    } catch (error) {
      console.error("[RSS] Error listing feeds:", error.message);
      response.status(500).json({ error: error.message });
    }
  },

  /**
   * Add a new feed
   * POST /api/feeds
   * Body: { url: string }
   */
  async add(request, response) {
    try {
      const { url } = request.body;

      if (!url || !isValidUrl(url)) {
        return response.status(400).json({
          error: response.locals.__("rss.error.invalidUrl"),
        });
      }

      const normalizedUrl = normalizeUrl(url);
      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.status(500).json({ error: "Database not available" });
      }

      const feedsCollection = db.collection("rssFeeds");

      // Check if feed already exists
      const existing = await feedsCollection.findOne({ url: normalizedUrl });
      if (existing) {
        return response.status(409).json({
          error: response.locals.__("rss.error.feedExists"),
        });
      }

      // Fetch feed to validate and get metadata
      const { rssConfig } = request.app.locals.application;
      const client = new RssClient({
        timeout: rssConfig?.fetchTimeout || 10_000,
      });

      let feedMeta;
      try {
        const result = await client.fetchFeed(normalizedUrl);
        feedMeta = result.feed;
      } catch (error) {
        return response.status(400).json({
          error: `${response.locals.__("rss.error.fetchFailed")}: ${error.message}`,
        });
      }

      // Insert feed
      const feed = {
        url: normalizedUrl,
        title: feedMeta.title,
        siteUrl: feedMeta.siteUrl,
        description: feedMeta.description,
        imageUrl: feedMeta.imageUrl,
        enabled: true,
        addedAt: new Date(),
        lastFetchedAt: null,
        lastError: null,
        itemCount: 0,
      };

      const result = await feedsCollection.insertOne(feed);
      feed._id = result.insertedId;

      response.status(201).json({
        message: response.locals.__("rss.success.feedAdded"),
        feed: formatFeed(feed),
      });
    } catch (error) {
      console.error("[RSS] Error adding feed:", error.message);
      response.status(500).json({ error: error.message });
    }
  },

  /**
   * Remove a feed
   * DELETE /api/feeds/:id
   */
  async remove(request, response) {
    try {
      const { id } = request.params;

      if (!ObjectId.isValid(id)) {
        return response.status(400).json({ error: "Invalid feed ID" });
      }

      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.status(500).json({ error: "Database not available" });
      }

      const feedsCollection = db.collection("rssFeeds");
      const itemsCollection = db.collection("rssItems");
      const feedId = new ObjectId(id);

      // Check if feed exists
      const feed = await feedsCollection.findOne({ _id: feedId });
      if (!feed) {
        return response.status(404).json({
          error: response.locals.__("rss.error.feedNotFound"),
        });
      }

      // Delete feed and its items
      await itemsCollection.deleteMany({ feedId });
      await feedsCollection.deleteOne({ _id: feedId });

      response.json({
        message: response.locals.__("rss.success.feedRemoved"),
      });
    } catch (error) {
      console.error("[RSS] Error removing feed:", error.message);
      response.status(500).json({ error: error.message });
    }
  },

  /**
   * Toggle feed enabled/disabled
   * PATCH /api/feeds/:id
   * Body: { enabled: boolean }
   */
  async toggle(request, response) {
    try {
      const { id } = request.params;
      const { enabled } = request.body;

      if (!ObjectId.isValid(id)) {
        return response.status(400).json({ error: "Invalid feed ID" });
      }

      if (typeof enabled !== "boolean") {
        return response.status(400).json({ error: "enabled must be boolean" });
      }

      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.status(500).json({ error: "Database not available" });
      }

      const feedsCollection = db.collection("rssFeeds");
      const feedId = new ObjectId(id);

      const result = await feedsCollection.findOneAndUpdate(
        { _id: feedId },
        { $set: { enabled } },
        { returnDocument: "after" }
      );

      if (!result) {
        return response.status(404).json({
          error: response.locals.__("rss.error.feedNotFound"),
        });
      }

      response.json({
        message: enabled
          ? response.locals.__("rss.success.feedEnabled")
          : response.locals.__("rss.success.feedDisabled"),
        feed: formatFeed(result),
      });
    } catch (error) {
      console.error("[RSS] Error toggling feed:", error.message);
      response.status(500).json({ error: error.message });
    }
  },
};
