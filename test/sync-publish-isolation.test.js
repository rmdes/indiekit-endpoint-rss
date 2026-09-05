import test from "node:test";
import assert from "node:assert/strict";

import { runSync } from "../lib/sync.js";

/**
 * Minimal fake Mongo-ish db exercising the exact call shapes runSync makes:
 * createIndexes, normalizeLegacyFeedDates, the enabled-feeds scan, syncFeed's
 * per-feed error path (RSS fetch is mocked to fail, so item upsert is never
 * reached), publishPending's pending-item query, and pruneOldItems' keep-list
 * query.
 *
 * Feed "a"'s publishPending query (the one carrying `postedAt`) throws, to
 * simulate a DB hiccup happening inside publishPending itself, outside its
 * own per-item try/catch. Feed "b" has one real pending item and is expected
 * to publish normally regardless.
 */
function makeDb() {
  const feeds = [
    { _id: "a", url: "https://feed-a.example/feed.xml", enabled: true, publish: { enabled: true, postType: "bookmark", content: "{{description}}", linkProperty: "bookmark-of" } },
    { _id: "b", url: "https://feed-b.example/feed.xml", enabled: true, publish: { enabled: true, postType: "bookmark", content: "{{description}}", linkProperty: "bookmark-of" } },
  ];

  const items = [
    {
      _id: 1,
      feedId: "b",
      guid: "g0",
      title: "Item 0",
      link: "https://example.com/0",
      description: "Summary",
      pubDate: new Date("2026-06-01T00:00:00.000Z"),
    },
  ];

  const feedsCollection = {
    find(query = {}) {
      if ("addedAt" in query) return { toArray: async () => [] };
      // Both { enabled: true } and the prune step's { } want every feed here.
      return { toArray: async () => feeds };
    },
    createIndex: async () => {},
    updateOne: async () => ({ modifiedCount: 1 }),
  };

  const itemsCollection = {
    createIndex: async () => {},
    find(query) {
      // publishPending's pending-item query always carries `postedAt`; the
      // prune step's keep-list query is bare `{ feedId }`. Only the former
      // is where we inject the failure, so prune for feed "a" is unaffected.
      if (query.feedId === "a" && "postedAt" in query) {
        throw new Error("db unavailable");
      }

      const matches = items.filter((item) => {
        if (item.feedId !== query.feedId) return false;
        if ("postedAt" in query && "postedAt" in item) return false;
        return true;
      });

      return {
        sort: () => ({
          limit: (n) => ({
            toArray: async () => matches.slice(0, n),
            project: () => ({
              toArray: async () => matches.slice(0, n).map((item) => ({ _id: item._id })),
            }),
          }),
        }),
      };
    },
    updateOne: async (filter, update) => {
      const item = items.find((entry) => entry._id === filter._id);
      if (item && update.$set) Object.assign(item, update.$set);
      return { modifiedCount: 1 };
    },
    deleteMany: async () => ({ deletedCount: 0 }),
    countDocuments: async () => items.length,
  };

  return {
    collection: (name) => (name === "rssFeeds" ? feedsCollection : itemsCollection),
    items,
  };
}

test("one feed's publish failure does not stop another feed's publish or the prune", async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.SECRET;
  process.env.SECRET = "test-secret";

  const micropubEndpoint = "http://localhost:8080/micropub";
  globalThis.fetch = async (url) => {
    if (url === micropubEndpoint) {
      return {
        ok: true,
        status: 201,
        headers: new Headers({ location: "https://example.com/posts/1" }),
        text: async () => "",
      };
    }
    // Every RSS feed URL in this test: syncFeed's own try/catch handles it,
    // so the sync insertion step is a no-op and does not interfere.
    throw new Error("network unreachable");
  };

  try {
    const db = makeDb();
    const result = await runSync(
      db,
      { maxConcurrentFetches: 2, retentionDays: 30, minItemsPerFeed: 10, maxPostsPerCycle: 10 },
      { micropubEndpoint, me: "https://example.com/" },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.itemsPublished, 1, "feed b must still publish");
    assert.equal(
      db.items.find((item) => item.feedId === "b").postedAt !== undefined,
      true,
    );
    assert.equal(typeof result.itemsPruned, "number", "the prune must still run");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SECRET = originalSecret;
  }
});
