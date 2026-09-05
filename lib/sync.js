import { RssClient } from "./rss-client.js";
import { publishPending, resolvePublishContext } from "./publisher.js";

let syncInterval = null;
let initialSyncTimeout = null;
let syncState = {
  lastSync: null,
  syncing: false,
  lastError: null,
  feedsProcessed: 0,
  itemsAdded: 0,
};

/**
 * Get current sync state
 * @returns {Object}
 */
export function getSyncState() {
  return { ...syncState };
}

/**
 * Start background sync
 * @param {Object} Indiekit - Indiekit instance
 * @param {Object} options - Plugin options
 */
export function startSync(Indiekit, options) {
  const intervalMs = options.syncInterval || 900_000; // 15 minutes default

  // Starting twice would orphan the previous timers with no handle to clear.
  stopSync();

  console.log(
    `[RSS] Starting background sync with ${intervalMs / 60_000}min interval`
  );

  // Initial sync after delay
  initialSyncTimeout = setTimeout(() => {
    initialSyncTimeout = null;
    runSync(Indiekit, options).catch((err) => {
      console.error("[RSS] Initial sync error:", err.message);
    });
  }, 10_000); // 10 second delay

  // Schedule recurring sync
  syncInterval = setInterval(() => {
    runSync(Indiekit, options).catch((err) => {
      console.error("[RSS] Sync error:", err.message);
    });
  }, intervalMs);
}

/**
 * Stop background sync
 */
export function stopSync() {
  const wasRunning = Boolean(syncInterval || initialSyncTimeout);

  // Both timers matter: destroy() within the first 10 seconds would otherwise
  // still fire an initial sync against a torn-down plugin.
  clearTimeout(initialSyncTimeout);
  initialSyncTimeout = null;
  clearInterval(syncInterval);
  syncInterval = null;

  if (wasRunning) {
    console.log("[RSS] Background sync stopped");
  }
}

/**
 * Run a single sync cycle
 * @param {Object} dbOrIndiekit - Database instance or Indiekit instance (for backwards compat)
 * @param {Object} options - Plugin options
 * @param {Object|null} [publishContext] - { micropubEndpoint, me }. Callers with
 *   a request (manual sync controllers) should supply their own resolved
 *   values; background sync has none, so it derives its own from the
 *   Indiekit instance.
 * @returns {Promise<Object>}
 */
export async function runSync(dbOrIndiekit, options, publishContext) {
  // Support both direct db object and Indiekit object (for background sync)
  const db = dbOrIndiekit.database || dbOrIndiekit;
  if (!db || typeof db.collection !== "function") {
    syncState.lastError = "No database available";
    return { error: syncState.lastError };
  }

  publishContext =
    publishContext ??
    (dbOrIndiekit.config
      ? resolvePublishContext(
          dbOrIndiekit.config.application,
          dbOrIndiekit.config.publication,
        )
      : null);

  if (syncState.syncing) {
    return { error: "Sync already in progress" };
  }

  syncState.syncing = true;
  syncState.lastError = null;
  syncState.feedsProcessed = 0;
  syncState.itemsAdded = 0;

  const client = new RssClient({
    timeout: options.fetchTimeout || 10_000,
  });

  try {
    const feedsCollection = db.collection("rssFeeds");
    const itemsCollection = db.collection("rssItems");

    // Create indexes if they don't exist
    await createIndexes(feedsCollection, itemsCollection);
    await normalizeLegacyFeedDates(feedsCollection);

    // Get all enabled feeds
    const feeds = await feedsCollection.find({ enabled: true }).toArray();

    if (feeds.length === 0) {
      syncState.lastSync = new Date().toISOString();
      syncState.syncing = false;
      return { feedsProcessed: 0, itemsAdded: 0 };
    }

    // Process feeds with concurrency limit
    const maxConcurrent = options.maxConcurrentFetches || 3;
    const results = await processFeedsWithLimit(
      feeds,
      maxConcurrent,
      async (feed) => {
        return syncFeed(feed, feedsCollection, itemsCollection, client, options);
      }
    );

    // Aggregate results
    for (const result of results) {
      if (result.itemsAdded) {
        syncState.itemsAdded += result.itemsAdded;
      }
      syncState.feedsProcessed++;
    }

    // Publish items from feeds wired to Micropub. Runs after insertion so it
    // reads what syncFeed just wrote, and before the prune so nothing is
    // published from items about to be removed.
    let itemsPublished = 0;

    if (publishContext) {
      for (const feed of feeds.filter((entry) => entry.publish?.enabled)) {
        try {
          const result = await publishPending(feed, itemsCollection, {
            ...publishContext,
            maxPostsPerCycle: options.maxPostsPerCycle || 10,
            postIntervalMs: options.postIntervalMs ?? 5000,
          });
          itemsPublished += result.published;
        } catch (error) {
          // One feed's failure must not cost the remaining feeds their publish
          // step, nor the cycle its prune. syncFeed isolates per feed the same
          // way.
          console.error(
            `[RSS] Publish failed for ${feed.url}: ${error.message}`,
          );
        }
      }
    }

    // Prune old items
    const retentionDays = options.retentionDays || 30;
    const itemsPruned = await pruneOldItems(
      itemsCollection,
      feedsCollection,
      retentionDays,
      retentionFloor(options),
    );

    syncState.lastSync = new Date().toISOString();
    syncState.syncing = false;

    console.log(
      `[RSS] Sync complete: ${syncState.feedsProcessed} feeds, ${syncState.itemsAdded} new items, ${itemsPublished} published, ${itemsPruned} pruned`
    );

    return {
      feedsProcessed: syncState.feedsProcessed,
      itemsAdded: syncState.itemsAdded,
      itemsPublished,
      itemsPruned,
    };
  } catch (error) {
    syncState.lastError = error.message;
    syncState.syncing = false;
    console.error("[RSS] Sync failed:", error.message);
    return { error: error.message };
  }
}

/**
 * Sync a single feed
 * @param {Object} feed - Feed document
 * @param {Collection} feedsCollection - Feeds collection
 * @param {Collection} itemsCollection - Items collection
 * @param {RssClient} client - RSS client
 * @param {Object} options - Plugin options
 * @returns {Promise<Object>}
 */
async function syncFeed(
  feed,
  feedsCollection,
  itemsCollection,
  client,
  options
) {
  const maxItemsPerFeed = options.maxItemsPerFeed || 50;
  let itemsAdded = 0;
  let lastError = null;

  try {
    const { feed: feedMeta, items } = await client.fetchFeed(feed.url);

    // Update feed metadata
    await feedsCollection.updateOne(
      { _id: feed._id },
      {
        $set: {
          title: feedMeta.title,
          siteUrl: feedMeta.siteUrl,
          description: feedMeta.description,
          imageUrl: feedMeta.imageUrl,
          lastFetchedAt: new Date().toISOString(),
          lastError: null,
        },
      }
    );

    // Insert new items
    const recentItems = items.slice(0, maxItemsPerFeed);
    for (const item of recentItems) {
      try {
        const result = await itemsCollection.updateOne(
          {
            feedId: feed._id,
            guid: item.guid,
          },
          {
            $setOnInsert: {
              feedId: feed._id,
              feedTitle: feedMeta.title,
              ...item,
              fetchedAt: new Date().toISOString(),
            },
          },
          { upsert: true }
        );

        if (result.upsertedCount > 0) {
          itemsAdded++;
        }
      } catch (err) {
        // Ignore duplicate key errors
        if (err.code !== 11000) {
          console.error(`[RSS] Error inserting item: ${err.message}`);
        }
      }
    }

    // Update item count
    const itemCount = await itemsCollection.countDocuments({ feedId: feed._id });
    await feedsCollection.updateOne(
      { _id: feed._id },
      { $set: { itemCount } }
    );

    return { feedId: feed._id, itemsAdded };
  } catch (error) {
    lastError = error.message;
    console.error(`[RSS] Error syncing ${feed.url}: ${lastError}`);

    // Update feed with error
    await feedsCollection.updateOne(
      { _id: feed._id },
      {
        $set: {
          lastFetchedAt: new Date().toISOString(),
          lastError: lastError,
        },
      }
    );

    return { feedId: feed._id, itemsAdded: 0, error: lastError };
  }
}

/**
 * Create indexes for collections
 * @param {Collection} feedsCollection
 * @param {Collection} itemsCollection
 */
async function createIndexes(feedsCollection, itemsCollection) {
  // Feeds indexes
  await feedsCollection.createIndex({ url: 1 }, { unique: true });
  await feedsCollection.createIndex({ enabled: 1 });

  // Items indexes
  await itemsCollection.createIndex({ feedId: 1, guid: 1 }, { unique: true });
  await itemsCollection.createIndex({ feedId: 1 });
  await itemsCollection.createIndex({ pubDate: -1 });
  await itemsCollection.createIndex({ fetchedAt: -1 });
}

/**
 * Number of newest items per feed that pruning must never touch.
 *
 * Pruning an item the feed still serves is a no-op by construction — the next
 * sync re-inserts it. A sync stores at most `maxItemsPerFeed` items per feed,
 * so age-based retention below that threshold can only churn: insert, delete,
 * refetch, forever. The floor is therefore derived from what a sync can store,
 * not set as an independent constant.
 * @param {object} options - Plugin options
 * @returns {number} Items to keep per feed regardless of age
 */
export function retentionFloor(options = {}) {
  return Math.max(options.minItemsPerFeed ?? 10, options.maxItemsPerFeed ?? 50);
}

/**
 * Rewrite legacy BSON Date values of `addedAt` as ISO 8601 strings.
 *
 * Indiekit stores dates as ISO strings. Feeds added before that was fixed hold
 * a BSON Date, and in BSON a Date sorts after every string — so a mixed
 * collection buries newly added feeds at the bottom of { addedAt: -1 }.
 * No-op once every row has been converted.
 * @param {Collection} feedsCollection - Feeds collection
 * @returns {Promise<number>} Number of feeds normalized
 */
export async function normalizeLegacyFeedDates(feedsCollection) {
  const legacy = await feedsCollection
    .find({ addedAt: { $type: "date" } })
    .toArray();

  for (const feed of legacy) {
    await feedsCollection.updateOne(
      { _id: feed._id },
      { $set: { addedAt: feed.addedAt.toISOString() } },
    );
  }

  if (legacy.length > 0) {
    console.log(`[RSS] Normalized addedAt on ${legacy.length} feed(s)`);
  }

  return legacy.length;
}

/**
 * Prune items older than the retention period.
 *
 * The newest `minItemsPerFeed` items of every feed are kept whatever their
 * age. Without that floor a low-traffic feed whose whole backlog predates the
 * cutoff is emptied and refetched on every single sync, so it churns forever
 * and always reads as empty.
 * @param {Collection} itemsCollection - Items collection
 * @param {Collection} feedsCollection - Feeds collection
 * @param {number} retentionDays - Days to keep items
 * @param {number} minItemsPerFeed - Newest items always kept per feed
 * @returns {Promise<number>} Number of items pruned
 */
export async function pruneOldItems(
  itemsCollection,
  feedsCollection,
  retentionDays,
  minItemsPerFeed = 10,
) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  try {
    const feeds = await feedsCollection.find({}).toArray();
    let deletedCount = 0;

    for (const feed of feeds) {
      const keep = await itemsCollection
        .find({ feedId: feed._id })
        .sort({ pubDate: -1 })
        .limit(minItemsPerFeed)
        .project({ _id: 1 })
        .toArray();

      const result = await itemsCollection.deleteMany({
        feedId: feed._id,
        // $ne: null also excludes missing dates: in BSON null sorts before
        // Date, so a bare $lt would delete every undated item as "too old".
        pubDate: { $lt: cutoff, $ne: null },
        // A published item is never forgotten: if the feed re-serves it later
        // it would return without postedAt and be published a second time.
        postedAt: { $exists: false },
        _id: { $nin: keep.map((item) => item._id) },
      });

      if (result.deletedCount > 0) {
        deletedCount += result.deletedCount;

        const itemCount = await itemsCollection.countDocuments({
          feedId: feed._id,
        });
        await feedsCollection.updateOne(
          { _id: feed._id },
          { $set: { itemCount } },
        );
      }
    }

    if (deletedCount > 0) {
      console.log(
        `[RSS] Pruned ${deletedCount} items older than ${retentionDays} days`,
      );
    }

    return deletedCount;
  } catch (err) {
    console.error("[RSS] Prune error:", err.message);
    return 0;
  }
}

/**
 * Process feeds with concurrency limit
 * @param {Array} feeds - Array of feeds
 * @param {number} limit - Concurrency limit
 * @param {Function} processor - Async function to process each feed
 * @returns {Promise<Array>}
 */
async function processFeedsWithLimit(feeds, limit, processor) {
  const results = [];
  const executing = [];

  for (const feed of feeds) {
    const promise = processor(feed).then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });
    results.push(promise);
    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Sync a single feed by ID (for manual refresh)
 * @param {Object} db - Database instance
 * @param {string} feedId - Feed ID
 * @param {Object} options - Plugin options
 * @returns {Promise<Object>}
 */
export async function syncSingleFeed(db, feedId, options) {
  const { ObjectId } = await import("mongodb");
  const feedsCollection = db.collection("rssFeeds");
  const itemsCollection = db.collection("rssItems");

  const feed = await feedsCollection.findOne({ _id: new ObjectId(feedId) });
  if (!feed) {
    return { error: "Feed not found" };
  }

  const client = new RssClient({
    timeout: options.fetchTimeout || 10_000,
  });

  return syncFeed(feed, feedsCollection, itemsCollection, client, options);
}
