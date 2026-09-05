import jwt from "jsonwebtoken";
import { jf2ToMf2 } from "@indiekit/endpoint-micropub/lib/mf2.js";

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
