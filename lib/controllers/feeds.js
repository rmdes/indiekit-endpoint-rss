import { ObjectId } from "mongodb";
import { RssClient } from "../rss-client.js";
import { defaultContent, defaultLinkProperty } from "../jf2-builder.js";
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
        addedAt: new Date().toISOString(),
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
   * Update a feed: enable/disable, or change its publish configuration
   * PATCH /api/feeds/:id
   * Body: { enabled?: boolean, publish?: object }
   */
  async toggle(request, response) {
    try {
      const { id } = request.params;
      const { enabled, publish } = request.body;

      if (!ObjectId.isValid(id)) {
        return response.status(400).json({ error: "Invalid feed ID" });
      }

      if (enabled === undefined && publish === undefined) {
        return response.status(400).json({ error: "Nothing to update" });
      }

      if (enabled !== undefined && typeof enabled !== "boolean") {
        return response.status(400).json({ error: "enabled must be boolean" });
      }

      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.status(500).json({ error: "Database not available" });
      }

      const feedsCollection = db.collection("rssFeeds");
      const feedId = new ObjectId(id);
      const feed = await feedsCollection.findOne({ _id: feedId });

      if (!feed) {
        return response.status(404).json({
          error: response.locals.__("rss.error.feedNotFound"),
        });
      }

      const update = {};

      if (enabled !== undefined) {
        update.enabled = enabled;
      }

      if (publish !== undefined) {
        const { postTypes } = request.app.locals.publication || {};

        // postData.create() throws notImplemented for an unconfigured type,
        // and the failure would be buried deep in the sync loop. Sites differ:
        // chardonsbleus has audio, event, jam and rsvp disabled.
        if (
          publish.enabled &&
          postTypes &&
          !Object.hasOwn(postTypes, publish.postType)
        ) {
          return response.status(400).json({
            error: `Post type "${publish.postType}" is not enabled on this site`,
          });
        }

        const merged = { ...feed.publish, ...publish };

        update.publish = {
          ...merged,
          // Pre-fill from the post type when the caller left them out, so a
          // minimal PATCH of { enabled, postType } yields a working config.
          // An explicit null is respected: it means "no link property".
          content: merged.content || defaultContent(merged.postType),
          linkProperty:
            publish.linkProperty === undefined
              ? (merged.linkProperty ?? defaultLinkProperty(merged.postType))
              : publish.linkProperty,
          // Stamp the watermark the first time publishing is switched on, so
          // enabling a feed does not publish its entire cached backlog.
          since:
            publish.enabled && !feed.publish?.since
              ? new Date().toISOString()
              : (feed.publish?.since ?? null),
        };
      }

      const result = await feedsCollection.findOneAndUpdate(
        { _id: feedId },
        { $set: update },
        { returnDocument: "after" },
      );

      response.json({
        message:
          enabled === undefined
            ? response.locals.__("rss.success.feedUpdated")
            : enabled
              ? response.locals.__("rss.success.feedEnabled")
              : response.locals.__("rss.success.feedDisabled"),
        feed: formatFeed(result),
      });
    } catch (error) {
      console.error("[RSS] Error updating feed:", error.message);
      response.status(500).json({ error: error.message });
    }
  },
};
