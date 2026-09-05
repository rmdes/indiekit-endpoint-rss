import jwt from "jsonwebtoken";
import { jf2ToMf2 } from "@indiekit/endpoint-micropub/lib/mf2.js";
import { buildJf2 } from "./jf2-builder.js";

const TOKEN_TTL = "5m";

/**
 * Mint a short-lived token for background publishing.
 *
 * Background sync has no user session, so it cannot reuse the admin UI's
 * access token. endpoint-auth signs and verifies with process.env.SECRET,
 * the same mechanism start.sh already uses for the syndication poller.
 * @param {string} me - Publication URL
 * @returns {string} Signed JWT
 */
export function mintToken(me) {
  if (!process.env.SECRET) {
    throw new Error("Cannot publish: SECRET is not configured");
  }

  return jwt.sign({ me, scope: "create" }, process.env.SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

/**
 * POST one post to the site's own Micropub endpoint.
 *
 * The endpoint parses any JSON body as mf2, so JF2 properties are converted
 * first — the same thing endpoint-posts does before calling the endpoint.
 * jf2ToMf2 mutates its input (deletes `properties.type`), so a copy is
 * passed to avoid corrupting the caller's object.
 * @param {string} micropubEndpoint - Micropub endpoint URL
 * @param {string} accessToken - Bearer token
 * @param {object} properties - JF2 properties
 * @param {object} [options] - Options
 * @param {Function} [options.fetchImpl] - fetch implementation, for tests
 * @returns {Promise<string|null>} URL of the created post
 */
export async function postToMicropub(
  micropubEndpoint,
  accessToken,
  properties,
  { fetchImpl = fetch } = {},
) {
  const mf2 = jf2ToMf2({ properties: { ...properties } });

  const response = await fetchImpl(micropubEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(mf2),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Micropub ${response.status}: ${body.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }

  return response.headers.get("location");
}

/**
 * Resolve what publishing needs from Indiekit configuration.
 *
 * micropubEndpoint is only resolved against the request in Indiekit's locals
 * middleware, and background sync has no request. Relative endpoints are
 * therefore resolved against localhost — the same loopback start.sh already
 * uses for the syndication and webmention pollers.
 * @param {object} application - Application configuration
 * @param {object} publication - Publication configuration
 * @returns {object|null} { micropubEndpoint, me }, or null when unconfigured
 */
export function resolvePublishContext(application = {}, publication = {}) {
  const { micropubEndpoint, port } = application;
  const { me } = publication;

  if (!micropubEndpoint || !me) {
    return null;
  }

  if (URL.canParse(micropubEndpoint)) {
    return { micropubEndpoint, me };
  }

  // A misconfigured port must cost this site its publishing, not its whole
  // sync cycle: this runs before runSync's try block, so a throw here would
  // skip the feed fetch, the inserts and the prune too, every cycle, with
  // nothing but a console.error to show for it.
  const base = `http://localhost:${port || "3000"}`;
  if (!URL.canParse(micropubEndpoint, base)) {
    return null;
  }

  return { micropubEndpoint: new URL(micropubEndpoint, base).href, me };
}

const MAX_ATTEMPTS = 3;

/**
 * Query selecting a feed's items that are still waiting to be published.
 *
 * Exported so the dashboard can count them with exactly the same rule the
 * publish loop applies. Two copies of this would drift, and the symptom would
 * be a count that disagrees with what actually publishes.
 * @param {object} feed - Feed document
 * @returns {object} MongoDB query
 */
export function pendingQuery(feed) {
  const query = {
    feedId: feed._id,
    postedAt: { $exists: false },
    postSkipped: { $ne: true },
  };

  if (feed.publish?.since) {
    const since = feed.publish.since;

    // One watermark, two operand types, because the two fields are stored
    // differently: pubDate is a BSON Date (rss-client builds real Dates and
    // pruneOldItems compares it against one), while fetchedAt — like every
    // other date here — is an ISO string. MongoDB orders by BSON type before
    // value, so a Date is never $gt a String: passing the ISO string to
    // pubDate matches nothing at all, with no error to show for it.
    //
    // An item with no parsable date would also be excluded forever by a bare
    // comparison, because null sorts below every Date. fetchedAt is always set
    // on insert and stands in when pubDate is missing.
    query.$or = [
      { pubDate: { $gt: new Date(since) } },
      { pubDate: null, fetchedAt: { $gt: since } },
    ];
  }

  return query;
}

/**
 * Publish the pending items of one feed.
 *
 * Retries are bounded on purpose: leaving postedAt unset retries next cycle,
 * and unbounded that reproduces the prune churn fixed in 1.0.17 — a
 * permanently invalid item retried every fifteen minutes forever.
 * @param {object} feed - Feed document
 * @param {object} itemsCollection - Items collection
 * @param {object} options - Options
 * @param {string} options.micropubEndpoint - Micropub endpoint URL
 * @param {string} options.me - Publication URL
 * @param {number} options.maxPostsPerCycle - Cap per cycle
 * @param {Function} [options.postImpl] - Post implementation, for tests
 * @param {Function} [options.mintImpl] - Token minter, for tests
 * @returns {Promise<object>} Counts for this feed
 */
export async function publishPending(feed, itemsCollection, options) {
  if (!feed.publish?.enabled) {
    return { published: 0, failed: 0 };
  }

  const {
    micropubEndpoint,
    me,
    maxPostsPerCycle,
    postImpl = postToMicropub,
    mintImpl = mintToken,
  } = options;

  const query = pendingQuery(feed);

  const items = await itemsCollection
    .find(query)
    .sort({ pubDate: 1 })
    .limit(maxPostsPerCycle)
    .toArray();

  if (items.length === 0) {
    return { published: 0, failed: 0 };
  }

  let published = 0;
  let failed = 0;

  // ponytail: a crash between POST and $set re-posts the item next cycle;
  // postData.create replaceOne's on the same URL, so it overwrites rather
  // than duplicates. Add a q=source reconciliation if a feed ever produces
  // non-deterministic slugs.
  for (const item of items) {
    try {
      // Minted per item, not once for the batch: signing is a cheap HMAC, and
      // a single batch token can expire mid-cycle on a slow endpoint. The
      // resulting 401 is a 4xx, so under the permanent-failure rule the tail
      // of the batch would be marked postSkipped and lost for good.
      const token = mintImpl(me);
      const properties = buildJf2(item, feed.publish);
      const postUrl = await postImpl(micropubEndpoint, token, properties);

      await itemsCollection.updateOne(
        { _id: item._id },
        { $set: { postedAt: new Date().toISOString(), postUrl } },
      );
      published++;
    } catch (error) {
      failed++;

      // A 4xx does not become a 201 on retry, and neither does an item that
      // structurally cannot be built. Both are permanent. Note postedAt is
      // never written here: pruneOldItems spares any item where it exists.
      const isPermanent =
        !error.status || (error.status >= 400 && error.status < 500);
      const attempts = (item.postAttempts || 0) + 1;

      await itemsCollection.updateOne(
        { _id: item._id },
        {
          $set: {
            postError: error.message,
            postErrorAt: new Date().toISOString(),
            ...(isPermanent || attempts >= MAX_ATTEMPTS
              ? { postSkipped: true }
              : {}),
          },
          $inc: { postAttempts: 1 },
        },
      );

      console.error(`[RSS] Publish failed for ${item.guid}: ${error.message}`);
    }
  }

  console.log(
    `[RSS] Published ${published} item(s) from ${feed.title || feed.url}${failed ? `, ${failed} failed` : ""}`,
  );

  return { published, failed };
}

/**
 * Resolve the watermark a backfill request should move the feed to.
 *
 * Backfill is not a separate publishing path: it rewinds publish.since and
 * lets the normal loop catch up at maxPostsPerCycle per cycle, which is
 * where the cap and the rate limit already live.
 * @param {object} request - { since } ISO date, or { last } item count
 * @param {Date|string|null} oldestPubDate - pubDate of the Nth newest item
 * @returns {string} ISO watermark
 */
export function watermarkFor({ since, last }, oldestPubDate) {
  if (since) {
    return new Date(since).toISOString();
  }

  if (last && oldestPubDate) {
    // One millisecond below, so the Nth item passes the loop's `$gt` filter.
    return new Date(new Date(oldestPubDate).getTime() - 1).toISOString();
  }

  throw new Error("Backfill requires since or last");
}
