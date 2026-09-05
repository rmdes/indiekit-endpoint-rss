import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLegacyFeedDates } from "../lib/sync.js";

/**
 * Fake feeds collection supporting just the { $type: "date" } filter the
 * normalization uses, plus updateOne applied in place.
 * @param {Array} feeds - Seed feed documents
 * @returns {Object} Fake collection plus a peek at the stored docs
 */
function makeFeedsCollection(feeds) {
  const docs = feeds.map((feed, index) => ({ _id: index + 1, ...feed }));

  return {
    collection: {
      find: (query) => ({
        toArray: async () => {
          const wanted = query.addedAt?.$type;
          return docs.filter((doc) =>
            wanted === "date" ? doc.addedAt instanceof Date : true,
          );
        },
      }),
      updateOne: async (filter, update) => {
        const doc = docs.find((entry) => entry._id === filter._id);
        Object.assign(doc, update.$set);
        return { modifiedCount: 1 };
      },
    },
    docs: () => docs,
  };
}

test("rewrites legacy Date values as ISO strings", async () => {
  const when = new Date("2026-06-01T19:19:51.693Z");
  const { collection, docs } = makeFeedsCollection([{ addedAt: when }]);

  const normalized = await normalizeLegacyFeedDates(collection);

  assert.equal(normalized, 1);
  assert.equal(docs()[0].addedAt, "2026-06-01T19:19:51.693Z");
});

test("leaves ISO strings alone and reports nothing to do", async () => {
  const { collection, docs } = makeFeedsCollection([
    { addedAt: "2026-06-01T19:19:51.693Z" },
  ]);

  const normalized = await normalizeLegacyFeedDates(collection);

  assert.equal(normalized, 0, "must be a no-op once converted");
  assert.equal(docs()[0].addedAt, "2026-06-01T19:19:51.693Z");
});

test("converts only the legacy rows in a mixed collection", async () => {
  // The mixed state is the harmful one: in BSON a Date sorts after every
  // string, so under { addedAt: -1 } the legacy rows outrank newer feeds.
  const { collection, docs } = makeFeedsCollection([
    { addedAt: new Date("2026-01-01T00:00:00.000Z") },
    { addedAt: "2026-08-01T00:00:00.000Z" },
    { addedAt: new Date("2026-02-01T00:00:00.000Z") },
  ]);

  const normalized = await normalizeLegacyFeedDates(collection);

  assert.equal(normalized, 2);
  assert.ok(
    docs().every((doc) => typeof doc.addedAt === "string"),
    "every addedAt must end up a string",
  );
});
