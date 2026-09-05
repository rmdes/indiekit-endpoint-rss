import test from "node:test";
import assert from "node:assert/strict";

import { mintToken, postToMicropub } from "../lib/publisher.js";

test("mintToken signs a create-scoped token with the site secret", async () => {
  process.env.SECRET = "test-secret-value";

  const token = mintToken("https://example.com/");
  const jwt = (await import("jsonwebtoken")).default;
  const claims = jwt.verify(token, "test-secret-value");

  assert.equal(claims.me, "https://example.com/");
  assert.equal(claims.scope, "create");
});

test("mintToken refuses to run without a secret", () => {
  delete process.env.SECRET;

  assert.throws(() => mintToken("https://example.com/"), /SECRET/);
});

test("postToMicropub returns the Location header on success", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 201,
      headers: new Headers({ location: "https://example.com/notes/1" }),
      text: async () => "",
    };
  };

  const url = await postToMicropub(
    "http://localhost:8080/micropub",
    "tok",
    { type: "entry", content: "hi" },
    { fetchImpl: fakeFetch },
  );

  assert.equal(url, "https://example.com/notes/1");
  assert.equal(calls[0].options.headers.authorization, "Bearer tok");
  // The endpoint parses JSON bodies as mf2, so mf2 is what must be sent.
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.type, ["h-entry"]);
  assert.deepEqual(body.properties.content, ["hi"]);
});

test("postToMicropub throws with status and body on failure", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    headers: new Headers(),
    text: async () => '{"error":"invalid_request"}',
  });

  await assert.rejects(
    () =>
      postToMicropub("http://localhost:8080/micropub", "tok", { type: "entry" }, {
        fetchImpl: fakeFetch,
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /invalid_request/);
      return true;
    },
  );
});

import { publishPending, watermarkFor } from "../lib/publisher.js";

/**
 * Fake items collection supporting the selection filter and $set/$inc updates.
 * @param {Array} items - Seed items
 * @returns {object} Collection plus a peek at the docs
 */
function makeItems(items) {
  const docs = items.map((item, index) => ({ _id: index + 1, ...item }));

  return {
    collection: {
      find: (query) => ({
        sort: () => ({
          limit: (n) => ({
            toArray: async () =>
              docs
                .filter((doc) => {
                  if (query.feedId && doc.feedId !== query.feedId) return false;
                  if (query.postedAt?.$exists === false && "postedAt" in doc)
                    return false;
                  if (query.postSkipped?.$ne === true && doc.postSkipped === true)
                    return false;
                  if (query.pubDate?.$gt && !(doc.pubDate > query.pubDate.$gt))
                    return false;
                  if (query.$or) {
                    const matches = query.$or.some((clause) => {
                      if (clause.pubDate === null) {
                        return (
                          (doc.pubDate === null || doc.pubDate === undefined) &&
                          new Date(doc.fetchedAt) > new Date(clause.fetchedAt.$gt)
                        );
                      }
                      return doc.pubDate > clause.pubDate.$gt;
                    });
                    if (!matches) return false;
                  }
                  return true;
                })
                .slice(0, n),
          }),
        }),
      }),
      updateOne: async (filter, update) => {
        const doc = docs.find((entry) => entry._id === filter._id);
        Object.assign(doc, update.$set);
        if (update.$inc) {
          for (const [key, by] of Object.entries(update.$inc)) {
            doc[key] = (doc[key] || 0) + by;
          }
        }
        return { modifiedCount: 1 };
      },
    },
    docs: () => docs,
  };
}

const feed = {
  _id: "a",
  title: "A feed",
  publish: {
    enabled: true,
    postType: "bookmark",
    content: "{{description}}",
    linkProperty: "bookmark-of",
    status: "draft",
    since: new Date("2026-01-01T00:00:00.000Z"),
  },
};

const pending = (n) =>
  Array.from({ length: n }, (_, i) => ({
    feedId: "a",
    guid: `g${i}`,
    title: `Item ${i}`,
    link: `https://example.com/${i}`,
    description: "Summary",
    pubDate: new Date("2026-06-01T00:00:00.000Z"),
  }));

const baseOptions = {
  micropubEndpoint: "http://localhost:8080/micropub",
  me: "https://example.com/",
  maxPostsPerCycle: 25,
  mintImpl: () => "tok",
};

test("publishes pending items and records where they landed", async () => {
  const { collection, docs } = makeItems(pending(2));

  const result = await publishPending(feed, collection, {
    ...baseOptions,
    postImpl: async () => "https://example.com/bookmarks/1",
  });

  assert.equal(result.published, 2);
  assert.ok(docs().every((doc) => doc.postedAt));
  assert.ok(docs().every((doc) => doc.postUrl === "https://example.com/bookmarks/1"));
});

test("postedAt is an ISO string, never a Date and never null", async () => {
  const { collection, docs } = makeItems(pending(1));

  await publishPending(feed, collection, {
    ...baseOptions,
    postImpl: async () => "https://example.com/x",
  });

  const { postedAt } = docs()[0];
  assert.equal(typeof postedAt, "string");
  assert.equal(postedAt, new Date(postedAt).toISOString());
});

test("respects the per-cycle cap", async () => {
  const { collection, docs } = makeItems(pending(30));

  const result = await publishPending(feed, collection, {
    ...baseOptions,
    postImpl: async () => "https://example.com/x",
  });

  assert.equal(result.published, 25);
  assert.equal(docs().filter((doc) => doc.postedAt).length, 25);
});

test("a 4xx is permanent and is not retried", async () => {
  const { collection, docs } = makeItems(pending(1));
  const error = new Error("Micropub 400: invalid_request");
  error.status = 400;

  const result = await publishPending(feed, collection, {
    ...baseOptions,
    postImpl: async () => {
      throw error;
    },
  });

  assert.equal(result.published, 0);
  assert.equal(docs()[0].postSkipped, true);
  // Critical: a failed item must not carry postedAt at all, not even null —
  // pruneOldItems spares anything where the field exists.
  assert.equal("postedAt" in docs()[0], false);
  assert.match(docs()[0].postError, /400/);
});

test("a 5xx is transient and is retried until the attempt limit", async () => {
  const { collection, docs } = makeItems(pending(1));
  const error = new Error("Micropub 503: unavailable");
  error.status = 503;
  const options = {
    ...baseOptions,
    postImpl: async () => {
      throw error;
    },
  };

  await publishPending(feed, collection, options);
  assert.equal(docs()[0].postAttempts, 1);
  assert.equal(docs()[0].postSkipped, undefined);

  await publishPending(feed, collection, options);
  await publishPending(feed, collection, options);

  assert.equal(docs()[0].postAttempts, 3);
  assert.equal(docs()[0].postSkipped, true, "retries must be bounded");
  assert.equal("postedAt" in docs()[0], false);
});

test("an item whose link property has no value fails permanently", async () => {
  const { collection, docs } = makeItems([{ ...pending(1)[0], link: null }]);

  const result = await publishPending(feed, collection, {
    ...baseOptions,
    postImpl: async () => "https://example.com/x",
  });

  assert.equal(result.published, 0);
  assert.equal(docs()[0].postSkipped, true);
});

test("a feed without publishing enabled is skipped entirely", async () => {
  const { collection, docs } = makeItems(pending(3));
  let posted = 0;

  const result = await publishPending(
    { ...feed, publish: { ...feed.publish, enabled: false } },
    collection,
    {
      ...baseOptions,
      postImpl: async () => {
        posted += 1;
        return "https://example.com/x";
      },
    },
  );

  assert.equal(result.published, 0);
  assert.equal(posted, 0);
  assert.ok(docs().every((doc) => !doc.postedAt));
});

test("one failing item does not stop the rest of the batch", async () => {
  const { collection, docs } = makeItems(pending(3));
  let call = 0;

  const result = await publishPending(feed, collection, {
    ...baseOptions,
    postImpl: async () => {
      call += 1;
      if (call === 2) {
        const error = new Error("Micropub 400: nope");
        error.status = 400;
        throw error;
      }
      return "https://example.com/x";
    },
  });

  assert.equal(result.published, 2);
  assert.equal(result.failed, 1);
  assert.equal(docs().filter((doc) => doc.postedAt).length, 2);
});

test("each item is posted with a freshly minted token", async () => {
  const { collection } = makeItems(pending(3));
  let minted = 0;

  await publishPending(feed, collection, {
    ...baseOptions,
    mintImpl: () => {
      minted += 1;
      return `tok${minted}`;
    },
    postImpl: async () => "https://example.com/x",
  });

  // One token per item: a single batch token would expire partway through a
  // slow batch, and the resulting 401s are 4xx, so the tail would be marked
  // permanently skipped and silently lost.
  assert.equal(minted, 3);
});

test("an item with no pubDate still publishes, using fetchedAt", async () => {
  const since = new Date("2026-01-01T00:00:00.000Z");
  const { collection, docs } = makeItems([
    {
      feedId: "a",
      guid: "undated",
      title: "Undated",
      link: "https://example.com/undated",
      description: "Summary",
      pubDate: null,
      fetchedAt: "2026-06-01T00:00:00.000Z",
    },
  ]);

  const result = await publishPending(
    { ...feed, publish: { ...feed.publish, since } },
    collection,
    { ...baseOptions, postImpl: async () => "https://example.com/x" },
  );

  assert.equal(result.published, 1);
  assert.ok(docs()[0].postedAt);
});

test("an undated item fetched before the watermark is not published", async () => {
  // The watermark must still hold for undated items, or enabling publishing
  // would replay the whole undated backlog.
  const since = new Date("2026-06-01T00:00:00.000Z");
  const { collection, docs } = makeItems([
    {
      feedId: "a",
      guid: "old",
      title: "Old",
      link: "https://example.com/old",
      description: "Summary",
      pubDate: null,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  const result = await publishPending(
    { ...feed, publish: { ...feed.publish, since } },
    collection,
    { ...baseOptions, postImpl: async () => "https://example.com/x" },
  );

  assert.equal(result.published, 0);
  assert.equal(docs()[0].postedAt, undefined);
});

test("an empty feed never mints a token", async () => {
  const { collection } = makeItems([]);
  let minted = 0;

  const result = await publishPending(feed, collection, {
    ...baseOptions,
    mintImpl: () => {
      minted += 1;
      return "tok";
    },
    postImpl: async () => "https://example.com/x",
  });

  assert.equal(result.published, 0);
  assert.equal(minted, 0);
});

test("backfill by date uses the given date", () => {
  assert.equal(
    watermarkFor({ since: "2026-01-01T00:00:00.000Z" }, null),
    "2026-01-01T00:00:00.000Z",
  );
});

test("backfill by count sits just below the Nth newest item", () => {
  assert.equal(
    watermarkFor({ last: 10 }, new Date("2026-06-01T00:00:00.000Z")),
    "2026-05-31T23:59:59.999Z",
  );
});

test("backfill needs one of the two", () => {
  assert.throws(() => watermarkFor({}, null), /since or last/);
});

import { pendingQuery } from "../lib/publisher.js";

test("pendingQuery excludes what has already been published or given up on", () => {
  const query = pendingQuery({ _id: "a", publish: { enabled: true } });

  assert.deepEqual(query.postedAt, { $exists: false });
  assert.deepEqual(query.postSkipped, { $ne: true });
  assert.equal(query.$or, undefined, "no watermark means no date filter");
});

test("pendingQuery honours the watermark on both dated and undated items", () => {
  const since = "2026-01-01T00:00:00.000Z";
  const query = pendingQuery({ _id: "a", publish: { enabled: true, since } });

  // Two branches: a real date after the watermark, or no date at all falling
  // back to when the item entered the cache.
  assert.deepEqual(query.$or, [
    { pubDate: { $gt: new Date(since) } },
    { pubDate: null, fetchedAt: { $gt: since } },
  ]);
});

test("each operand matches the BSON type its field is stored as", () => {
  // This is the check that would have caught the bug that shipped in 1.1.3.
  // pubDate is a BSON Date (rss-client builds real Dates, pruneOldItems
  // compares against one); fetchedAt is an ISO string like every other date
  // here. MongoDB orders by type before value, so a Date is never $gt a
  // String — passing the ISO string to pubDate matched nothing at all, with
  // no error, no log and no item touched.
  const query = pendingQuery({
    _id: "a",
    publish: { enabled: true, since: "2026-01-01T00:00:00.000Z" },
  });

  const [dated, undated] = query.$or;

  assert.ok(
    dated.pubDate.$gt instanceof Date,
    "pubDate is a BSON Date, so its operand must be a Date",
  );
  assert.equal(
    typeof undated.fetchedAt.$gt,
    "string",
    "fetchedAt is an ISO string, so its operand must be a string",
  );
});

test("an existing post is updated, not created a second time", async () => {
  // The file system store's createFile returns silently when the path exists,
  // so a second create updates the database row and leaves the published file
  // untouched. The two then disagree with nothing to show for it.
  let sent;
  const fakeFetch = async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, status: 200, headers: new Headers(), text: async () => "" };
  };

  await postToMicropub(
    "http://localhost:8080/micropub",
    "tok",
    { type: "entry", content: "new" },
    { fetchImpl: fakeFetch, replaces: "https://example.com/articles/1" },
  );

  assert.equal(sent.action, "update");
  assert.equal(sent.url, "https://example.com/articles/1");
  assert.deepEqual(sent.replace.content, ["new"]);
});

test("a first publish is still a plain create", async () => {
  let sent;
  const fakeFetch = async (url, options) => {
    sent = JSON.parse(options.body);
    return {
      ok: true,
      status: 201,
      headers: new Headers({ location: "https://example.com/x" }),
      text: async () => "",
    };
  };

  await postToMicropub(
    "http://localhost:8080/micropub",
    "tok",
    { type: "entry", content: "hi" },
    { fetchImpl: fakeFetch },
  );

  assert.equal(sent.action, undefined);
  assert.deepEqual(sent.type, ["h-entry"]);
});

test("republishing keeps the item's recorded url", async () => {
  const { collection, docs } = makeItems([
    { ...pending(1)[0], postUrl: "https://example.com/articles/1" },
  ]);

  await publishPending(feed, collection, {
    ...baseOptions,
    // An update returns no Location header; the known url must survive.
    postImpl: async () => null,
  });

  assert.equal(docs()[0].postUrl, "https://example.com/articles/1");
  assert.ok(docs()[0].postedAt);
});
