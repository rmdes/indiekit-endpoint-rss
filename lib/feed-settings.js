import { ObjectId } from "mongodb";

import { defaultContent, defaultLinkProperty } from "./jf2-builder.js";
import { pendingQuery, watermarkFor } from "./publisher.js";
import { isValidUrl, normalizeUrl } from "./utils.js";

/**
 * Apply a settings change to one feed.
 *
 * Shared by the JSON API and the dashboard form so the two cannot drift: two
 * copies of this validation would eventually disagree, and the symptom would
 * be a form that accepts what the API rejects.
 * @param {object} db - Database
 * @param {string} id - Feed id
 * @param {object} body - Fields to change: enabled, url, publish
 * @param {object} [publication] - Publication configuration
 * @returns {Promise<object>} Result carrying status, error, feed, eligible
 */
export async function applyFeedSettings(db, id, body, publication = {}) {
  const { enabled, publish, url } = body;

  if (!ObjectId.isValid(id)) {
    return { status: 400, error: "Invalid feed ID" };
  }

  if (enabled === undefined && publish === undefined && url === undefined) {
    return { status: 400, error: "Nothing to update" };
  }

  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { status: 400, error: "enabled must be boolean" };
  }

  const feedsCollection = db.collection("rssFeeds");
  const feedId = new ObjectId(id);
  const feed = await feedsCollection.findOne({ _id: feedId });

  if (!feed) {
    return { status: 404, error: "Feed not found" };
  }

  const update = {};

  if (enabled !== undefined) {
    update.enabled = enabled;
  }

  if (url !== undefined) {
    if (!isValidUrl(url)) {
      return { status: 400, error: "Invalid feed URL" };
    }

    const normalizedUrl = normalizeUrl(url);
    const clash = await feedsCollection.findOne({
      url: normalizedUrl,
      _id: { $ne: feedId },
    });

    if (clash) {
      return { status: 409, error: "Another feed already uses that URL" };
    }

    update.url = normalizedUrl;
    // Items key on feedId, so they survive the change. Any error from the old
    // URL is stale the moment it is corrected.
    update.lastError = null;
  }

  if (publish !== undefined) {
    const { postTypes } = publication;

    if (publish.enabled) {
      if (!postTypes) {
        return { status: 500, error: "Post type configuration unavailable" };
      }

      // postData.create() throws notImplemented for an unconfigured type, and
      // the failure would be buried deep in the sync loop. Sites differ:
      // chardonsbleus has audio, event, jam and rsvp disabled.
      if (!Object.hasOwn(postTypes, publish.postType)) {
        return {
          status: 400,
          error: `Post type "${publish.postType}" is not enabled on this site`,
        };
      }
    }

    const merged = { ...feed.publish, ...publish };

    update.publish = {
      ...merged,
      // Pre-fill from the post type when the caller left them out, so a
      // minimal update of enabled plus postType yields a working config. An
      // explicit null is respected: it means "no link property".
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

  // A feed can be correctly configured and still have nothing to publish, so
  // report the count rather than leaving the user to guess.
  let eligible;
  if (result.publish?.enabled) {
    eligible = await db
      .collection("rssItems")
      .countDocuments(pendingQuery(result));
  }

  return { status: 200, feed: result, eligible };
}

/**
 * Move a feed's watermark back so already-cached items become eligible.
 * @param {object} db - Database
 * @param {string} id - Feed id
 * @param {object} body - Either a since date or a last item count
 * @returns {Promise<object>} Result carrying status, error, since, eligible
 */
export async function rewindWatermark(db, id, body) {
  const { since, last } = body;

  if (!ObjectId.isValid(id)) {
    return { status: 400, error: "Invalid feed ID" };
  }

  const feedsCollection = db.collection("rssFeeds");
  const itemsCollection = db.collection("rssItems");
  const feedId = new ObjectId(id);
  const feed = await feedsCollection.findOne({ _id: feedId });

  if (!feed) {
    return { status: 404, error: "Feed not found" };
  }

  if (!feed.publish?.enabled) {
    return { status: 400, error: "Enable publishing on this feed first" };
  }

  let oldestPubDate = null;
  if (last) {
    const items = await itemsCollection
      .find({ feedId })
      .sort({ pubDate: -1 })
      .limit(Number(last))
      .toArray();
    oldestPubDate = items.at(-1)?.pubDate || null;
  }

  let watermark;
  try {
    watermark = watermarkFor({ since, last }, oldestPubDate);
  } catch (error) {
    return { status: 400, error: error.message };
  }

  // The feed's own post status is respected: silently forcing drafts would
  // override a deliberate choice. The guard is the count the user asked for,
  // and maxPostsPerCycle pacing the catch-up.
  const updated = await feedsCollection.findOneAndUpdate(
    { _id: feedId },
    { $set: { "publish.since": watermark } },
    { returnDocument: "after" },
  );

  const eligible = await itemsCollection.countDocuments(pendingQuery(updated));

  return { status: 200, since: watermark, eligible };
}

/**
 * Clear a feed's publish state so its items can be published again.
 *
 * Without this a feed is stuck the moment its items carry postedAt: changing
 * the template, the post type or the date source has no way to reach items
 * already sent. Existing posts are not deleted — republishing writes over the
 * same URL, because the slug is derived from the item's guid.
 * @param {object} db - Database
 * @param {string} id - Feed id
 * @returns {Promise<object>} Result carrying status, error, reset
 */
export async function resetPublishState(db, id) {
  if (!ObjectId.isValid(id)) {
    return { status: 400, error: "Invalid feed ID" };
  }

  const feedId = new ObjectId(id);
  const feed = await db.collection("rssFeeds").findOne({ _id: feedId });

  if (!feed) {
    return { status: 404, error: "Feed not found" };
  }

  const result = await db.collection("rssItems").updateMany(
    { feedId },
    // postUrl is kept on purpose: it tells the publisher the post already
    // exists, so the next attempt updates it instead of issuing a create the
    // file store would silently ignore.
    { $unset: { postedAt: "", postSkipped: "", postError: "", postErrorAt: "", postAttempts: "" } },
  );

  return { status: 200, reset: result.modifiedCount };
}
