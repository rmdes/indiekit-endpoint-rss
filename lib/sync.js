import { RssClient } from "./rss-client.js";

let syncInterval = null;
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

  console.log(
    `[RSS] Starting background sync with ${intervalMs / 60_000}min interval`
  );

  // Initial sync after delay
  setTimeout(() => {
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
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log("[RSS] Background sync stopped");
  }
}

/**
 * Run a single sync cycle
 * @param {Object} Indiekit - Indiekit instance
 * @param {Object} options - Plugin options
 * @returns {Promise<Object>}
 */
export async function runSync(Indiekit, options) {
  const db = Indiekit.database;
  if (!db) {
    syncState.lastError = "No database available";
    return { error: syncState.lastError };
  }

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

    // Get all enabled feeds
    const feeds = await feedsCollection.find({ enabled: true }).toArray();

    if (feeds.length === 0) {
      syncState.lastSync = new Date();
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

    syncState.lastSync = new Date();
    syncState.syncing = false;

    console.log(
      `[RSS] Sync complete: ${syncState.feedsProcessed} feeds, ${syncState.itemsAdded} new items`
    );

    return {
      feedsProcessed: syncState.feedsProcessed,
      itemsAdded: syncState.itemsAdded,
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
          lastFetchedAt: new Date(),
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
              fetchedAt: new Date(),
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
          lastFetchedAt: new Date(),
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
