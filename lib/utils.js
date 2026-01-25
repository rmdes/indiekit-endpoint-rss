import sanitizeHtmlLib from "sanitize-html";

/**
 * Sanitize HTML content - strip dangerous tags, keep basic formatting
 * @param {string} html - Raw HTML
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (!html) return "";
  return sanitizeHtmlLib(html, {
    allowedTags: [
      "p",
      "br",
      "b",
      "i",
      "em",
      "strong",
      "a",
      "ul",
      "ol",
      "li",
      "blockquote",
      "code",
      "pre",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel"],
    },
    allowedSchemes: ["http", "https", "mailto"],
  });
}

/**
 * Strip all HTML tags
 * @param {string} html - HTML content
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html) return "";
  return sanitizeHtmlLib(html, {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}

/**
 * Truncate text to specified length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string}
 */
export function truncateText(text, maxLength = 200) {
  if (!text) return "";
  const stripped = stripHtml(text);
  if (stripped.length <= maxLength) return stripped;
  const truncated = stripped.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.8 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

/**
 * Extract image URL from item content/enclosure
 * @param {Object} item - RSS item
 * @returns {string|null}
 */
export function extractImageUrl(item) {
  // Already extracted by client
  if (item.imageUrl) return item.imageUrl;

  // From enclosure
  if (item.enclosure?.url && isImageType(item.enclosure.type)) {
    return item.enclosure.url;
  }

  // From content
  const content = item.content || item.description || "";
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return null;
}

/**
 * Check if MIME type is an image
 * @param {string} type - MIME type
 * @returns {boolean}
 */
function isImageType(type) {
  if (!type) return false;
  return type.startsWith("image/");
}

/**
 * Format item for API response
 * @param {Object} item - MongoDB item document
 * @param {Object} options - Formatting options
 * @returns {Object}
 */
export function formatItem(item, options = {}) {
  const { includeContent = false, descriptionLength = 200 } = options;

  // Handle description - use item.description if available, otherwise generate from content
  let description = item.description;
  if (!description && item.content) {
    description = truncateText(item.content, descriptionLength);
  } else if (description) {
    description = truncateText(description, descriptionLength);
  }

  const formatted = {
    id: item._id?.toString(),
    feedId: item.feedId?.toString(),
    feedTitle: item.feedTitle,
    guid: item.guid,
    title: item.title,
    link: item.link,
    description: description || "",
    author: item.author,
    pubDate: item.pubDate?.toISOString(),
    imageUrl: item.imageUrl,
    categories: item.categories || [],
    fetchedAt: item.fetchedAt?.toISOString(),
    // Source info for aggregators (like FreshRSS) - represents the original feed
    sourceTitle: item.sourceTitle || null,
    sourceUrl: item.sourceUrl || null,
  };

  // Include origin object if present (for aggregator metadata)
  if (item.origin) {
    formatted.origin = item.origin;
  }

  if (includeContent) {
    formatted.content = sanitizeHtml(item.content);
  }

  if (item.enclosure) {
    formatted.enclosure = item.enclosure;
  }

  return formatted;
}

/**
 * Format feed for API response
 * @param {Object} feed - MongoDB feed document
 * @returns {Object}
 */
export function formatFeed(feed) {
  return {
    id: feed._id?.toString(),
    url: feed.url,
    title: feed.title,
    siteUrl: feed.siteUrl,
    description: feed.description,
    imageUrl: feed.imageUrl,
    enabled: feed.enabled,
    addedAt: feed.addedAt?.toISOString(),
    lastFetchedAt: feed.lastFetchedAt?.toISOString(),
    lastError: feed.lastError,
    itemCount: feed.itemCount || 0,
  };
}

/**
 * Format relative time (e.g., "5 minutes ago")
 * @param {Date|string} date - Date to format
 * @returns {string}
 */
export function formatRelativeTime(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";

  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString();
}

/**
 * Validate URL format
 * @param {string} url - URL to validate
 * @returns {boolean}
 */
export function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Normalize feed URL
 * @param {string} url - URL to normalize
 * @returns {string}
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove trailing slash
    let normalized = parsed.href;
    if (normalized.endsWith("/") && parsed.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;
  }
}
