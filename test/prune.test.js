import test from "node:test";
import assert from "node:assert/strict";

import { pruneOldItems } from "../lib/sync.js";

const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

/**
 * Minimal in-memory stand-in for the two MongoDB collections.
 *
 * It reproduces the BSON comparison rules that matter here: a null or missing
 * pubDate compares lower than any Date, and sorts last under { pubDate: -1 }.
 * @param {Array} items - Seed items, given an _id in order
 * @returns {Object} Fake collections plus a peek at what survived
 */
function makeCollections(items) {
  const docs = items.map((item, index) => ({ _id: index + 1, ...item }));
  const feeds = [...new Set(docs.map((doc) => doc.feedId))].map((id) => ({
    _id: id,
  }));

  const matches = (doc, query) =>
    Object.entries(query).every(([field, condition]) => {
      const value = doc[field] ?? null;
      if (
        condition === null ||
        condition instanceof Date ||
        typeof condition !== "object"
      ) {
        return value === condition;
      }
      return Object.entries(condition).every(([operator, operand]) => {
        switch (operator) {
          case "$lt":
            return value < operand; // null coerces low, as in BSON
          case "$ne":
            return value !== operand;
          case "$nin":
            return !operand.includes(value);
          case "$exists":
            return (field in doc) === operand;
          default:
            throw new Error(`unsupported operator: ${operator}`);
        }
      });
    });

  const itemsCollection = {
    find(query) {
      let found = docs.filter((doc) => matches(doc, query));
      return {
        sort() {
          found = [...found].sort(
            (a, b) => (b.pubDate?.getTime() ?? 0) - (a.pubDate?.getTime() ?? 0),
          );
          return this;
        },
        limit(n) {
          found = found.slice(0, n);
          return this;
        },
        project() {
          return this;
        },
        toArray: async () => found,
      };
    },
    async deleteMany(query) {
      const doomed = docs.filter((doc) => matches(doc, query));
      for (const doc of doomed) docs.splice(docs.indexOf(doc), 1);
      return { deletedCount: doomed.length };
    },
    async countDocuments(query) {
      return docs.filter((doc) => matches(doc, query)).length;
    },
  };

  const feedsCollection = {
    find: () => ({ toArray: async () => feeds }),
    updateOne: async () => ({ modifiedCount: 1 }),
  };

  return { itemsCollection, feedsCollection, remaining: () => docs };
}

test("keeps a whole low-traffic feed whose backlog predates the cutoff", async () => {
  // The chardonsbleus case: 10 posts, all far older than 30 days. Pruning them
  // empties the feed, the next sync refetches them, and it churns forever.
  const { itemsCollection, feedsCollection, remaining } = makeCollections(
    Array.from({ length: 10 }, (_, i) => ({
      feedId: "a",
      pubDate: daysAgo(400 + i),
    })),
  );

  const pruned = await pruneOldItems(itemsCollection, feedsCollection, 30, 10);

  assert.equal(pruned, 0);
  assert.equal(remaining().length, 10);
});

test("prunes only what exceeds the per-feed floor", async () => {
  const { itemsCollection, feedsCollection, remaining } = makeCollections(
    Array.from({ length: 15 }, (_, i) => ({
      feedId: "a",
      pubDate: daysAgo(400 + i),
    })),
  );

  const pruned = await pruneOldItems(itemsCollection, feedsCollection, 30, 10);

  assert.equal(pruned, 5);
  assert.equal(remaining().length, 10);
  // The survivors are the newest ten, not an arbitrary ten.
  assert.deepEqual(
    remaining().map((doc) => doc._id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test("never prunes undated items", async () => {
  // pubDate: null sorts below any Date, so a bare $lt would sweep these up.
  const { itemsCollection, feedsCollection, remaining } = makeCollections(
    Array.from({ length: 15 }, () => ({ feedId: "a", pubDate: null })),
  );

  const pruned = await pruneOldItems(itemsCollection, feedsCollection, 30, 10);

  assert.equal(pruned, 0);
  assert.equal(remaining().length, 15);
});

test("applies the floor per feed, not across all feeds", async () => {
  const { itemsCollection, feedsCollection, remaining } = makeCollections([
    ...Array.from({ length: 12 }, () => ({ feedId: "a", pubDate: daysAgo(400) })),
    ...Array.from({ length: 3 }, () => ({ feedId: "b", pubDate: daysAgo(400) })),
  ]);

  const pruned = await pruneOldItems(itemsCollection, feedsCollection, 30, 10);

  assert.equal(pruned, 2); // only feed "a" is over its floor
  assert.equal(remaining().filter((doc) => doc.feedId === "b").length, 3);
});

test("still prunes old items when recent ones fill the floor", async () => {
  const { itemsCollection, feedsCollection, remaining } = makeCollections([
    ...Array.from({ length: 10 }, (_, i) => ({
      feedId: "a",
      pubDate: daysAgo(i),
    })),
    ...Array.from({ length: 4 }, () => ({ feedId: "a", pubDate: daysAgo(400) })),
  ]);

  const pruned = await pruneOldItems(itemsCollection, feedsCollection, 30, 10);

  assert.equal(pruned, 4);
  assert.equal(remaining().length, 10);
});

test("never prunes an item that has already been published", async () => {
  // A pruned item that the feed later re-serves would come back without
  // postedAt and be published a second time.
  const { itemsCollection, feedsCollection, remaining } = makeCollections([
    ...Array.from({ length: 12 }, () => ({ feedId: "a", pubDate: daysAgo(400) })),
    { feedId: "a", pubDate: daysAgo(400), postedAt: "2026-01-01T00:00:00.000Z" },
  ]);

  await pruneOldItems(itemsCollection, feedsCollection, 30, 10);

  assert.equal(
    remaining().filter((doc) => doc.postedAt).length,
    1,
    "the published item must survive even outside the floor",
  );
});

test("postedAt: null counts as existing, not absent", async () => {
  // A field explicitly set to null still exists in MongoDB, so { $exists:
  // false } must not match it. If a failure path ever records postedAt:
  // null, this keeps such an item from being pruned as if it were untouched.
  const { itemsCollection, feedsCollection, remaining } = makeCollections([
    ...Array.from({ length: 12 }, () => ({ feedId: "a", pubDate: daysAgo(400) })),
    { feedId: "a", pubDate: daysAgo(400), postedAt: null },
  ]);

  await pruneOldItems(itemsCollection, feedsCollection, 30, 10);

  assert.equal(
    remaining().some((doc) => "postedAt" in doc),
    true,
    "an item with postedAt: null must survive, same as one already published",
  );
});

test("the retention floor is derived from what a sync can store", async () => {
  const { retentionFloor } = await import("../lib/sync.js");

  // Pruning an item the feed still serves only makes the next sync re-insert
  // it. Measured on rmendes before this: 49 items churned every cycle.
  assert.equal(retentionFloor({ minItemsPerFeed: 10, maxItemsPerFeed: 50 }), 50);
  assert.equal(retentionFloor({ minItemsPerFeed: 80, maxItemsPerFeed: 50 }), 80);
  assert.equal(retentionFloor({}), 50);
});
