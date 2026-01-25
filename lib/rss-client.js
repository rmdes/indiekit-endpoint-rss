import Parser from "rss-parser";
import { IndiekitError } from "@indiekit/error";

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

export class RssClient {
  constructor(options = {}) {
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.maxRedirects = options.maxRedirects || DEFAULT_MAX_REDIRECTS;
    this.parser = new Parser({
      timeout: this.timeout,
      maxRedirects: this.maxRedirects,
      headers: {
        "User-Agent": "Indiekit-RSS-Reader/1.0 (+https://getindiekit.com)",
        Accept:
          "application/feed+json, application/json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      customFields: {
        feed: ["image", "icon", "logo"],
        item: [
          ["media:content", "media"],
          ["media:thumbnail", "mediaThumbnail"],
          ["enclosure", "enclosure"],
          ["dc:creator", "creator"],
          ["content:encoded", "contentEncoded"],
        ],
      },
    });
  }

  /**
   * Fetch and parse an RSS/Atom/JSON feed
   * @param {string} url - Feed URL
   * @returns {Promise<{feed: Object, items: Array}>}
   */
  async fetchFeed(url) {
    try {
      // First, fetch the content to detect format
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Indiekit-RSS-Reader/1.0 (+https://getindiekit.com)",
          Accept:
            "application/feed+json, application/json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();

      // Detect JSON feed (JSON Feed format or Google Reader API JSON)
      if (
        contentType.includes("application/json") ||
        contentType.includes("application/feed+json") ||
        url.includes("f=greader") ||
        url.includes("f=json")
      ) {
        try {
          const json = JSON.parse(text);
          return this.parseJsonFeed(json, url);
        } catch {
          // Fall through to RSS parser if JSON parse fails
        }
      }

      // Use rss-parser for RSS/Atom
      const parsed = await this.parser.parseString(text);
      return {
        feed: this.extractFeedMeta(parsed, url),
        items: this.transformItems(parsed.items || [], url),
      };
    } catch (error) {
      throw new IndiekitError(`Failed to fetch feed: ${error.message}`, {
        status: 502,
        cause: error,
      });
    }
  }

  /**
   * Parse JSON feed (JSON Feed spec or Google Reader API format)
   * @param {Object} json - Parsed JSON
   * @param {string} feedUrl - Original feed URL
   * @returns {{feed: Object, items: Array}}
   */
  parseJsonFeed(json, feedUrl) {
    // Google Reader API format (items array at root level)
    if (json.items && !json.version) {
      return this.parseGoogleReaderJson(json, feedUrl);
    }

    // JSON Feed spec (https://jsonfeed.org/version/1.1)
    if (json.version?.startsWith("https://jsonfeed.org/")) {
      return this.parseJsonFeedSpec(json, feedUrl);
    }

    // Generic JSON with items array
    if (Array.isArray(json.items)) {
      return this.parseGoogleReaderJson(json, feedUrl);
    }

    throw new Error("Unknown JSON feed format");
  }

  /**
   * Parse Google Reader API / FreshRSS JSON format
   * @param {Object} json - Google Reader JSON
   * @param {string} feedUrl - Feed URL
   * @returns {{feed: Object, items: Array}}
   */
  parseGoogleReaderJson(json, feedUrl) {
    const feed = {
      title: json.title || "RSS Feed",
      description: json.description || "",
      siteUrl: json.link || json.alternate?.[0]?.href || this.extractBaseUrl(feedUrl),
      feedUrl: feedUrl,
      imageUrl: null,
      language: null,
      lastBuildDate: null,
    };

    const items = (json.items || []).map((item) => {
      // Parse timestamp - FreshRSS uses `published` (Unix seconds) or `timestampUsec` (microseconds)
      let pubDate = null;
      if (item.published) {
        // Unix timestamp in seconds
        pubDate = new Date(item.published * 1000);
      } else if (item.timestampUsec) {
        // Microseconds timestamp
        pubDate = new Date(parseInt(item.timestampUsec) / 1000);
      } else if (item.crawlTimeMsec) {
        // Milliseconds timestamp
        pubDate = new Date(parseInt(item.crawlTimeMsec));
      }

      // Extract content from various FreshRSS structures
      const content = item.content?.content ||
                     (typeof item.content === "string" ? item.content : "") ||
                     item.summary?.content ||
                     (typeof item.summary === "string" ? item.summary : "") ||
                     "";

      // Extract link from Google Reader format
      const link = item.canonical?.[0]?.href ||
                  item.alternate?.[0]?.href ||
                  item.link ||
                  null;

      // Filter out internal FreshRSS categories, keep only user tags
      const categories = (item.categories || []).filter(cat =>
        !cat.includes("state/com.google/") &&
        !cat.includes("state/org.freshrss/") &&
        !cat.startsWith("user/")
      );

      // For aggregators like FreshRSS, use origin info for the real source
      const originTitle = item.origin?.title || null;
      const originUrl = item.origin?.htmlUrl || null;

      // Extract a meaningful description/summary
      const description = this.extractDescription(content, item.summary);

      return {
        guid: item["frss:id"] || item.id || item.guid || link,
        title: item.title || "Untitled",
        link,
        description,
        content,
        // For author, prefer the actual author field, fall back to origin title only if no author
        author: item.author || null,
        pubDate,
        imageUrl: this.extractJsonItemImage(item, content),
        categories,
        enclosure: item.enclosure || null,
        // Preserve FreshRSS-specific metadata - use origin for real source feed
        origin: item.origin ? {
          streamId: item.origin.streamId,
          title: item.origin.title,
          htmlUrl: item.origin.htmlUrl,
          feedUrl: item.origin.feedUrl,
        } : null,
        // Denormalized fields for easier display
        sourceTitle: originTitle,
        sourceUrl: originUrl,
      };
    });

    return { feed, items };
  }

  /**
   * Parse JSON Feed spec format
   * @param {Object} json - JSON Feed object
   * @param {string} feedUrl - Feed URL
   * @returns {{feed: Object, items: Array}}
   */
  parseJsonFeedSpec(json, feedUrl) {
    const feed = {
      title: json.title || "Untitled Feed",
      description: json.description || "",
      siteUrl: json.home_page_url || this.extractBaseUrl(feedUrl),
      feedUrl: json.feed_url || feedUrl,
      imageUrl: json.icon || json.favicon || null,
      language: json.language || null,
      lastBuildDate: null,
    };

    const items = (json.items || []).map((item) => ({
      guid: item.id || item.url,
      title: item.title || "Untitled",
      link: item.url || item.external_url || null,
      description: item.summary || "",
      content: item.content_html || item.content_text || item.summary || "",
      author: item.authors?.[0]?.name || item.author?.name || null,
      pubDate: this.parseDate(item.date_published || item.date_modified),
      imageUrl: item.image || item.banner_image || null,
      categories: item.tags || [],
      enclosure: item.attachments?.[0]
        ? {
            url: item.attachments[0].url,
            type: item.attachments[0].mime_type,
            length: item.attachments[0].size_in_bytes,
          }
        : null,
    }));

    return { feed, items };
  }

  /**
   * Extract image from JSON feed item
   * @param {Object} item - JSON item
   * @param {string} content - Pre-extracted content string
   * @returns {string|null}
   */
  extractJsonItemImage(item, content = "") {
    // Direct image property
    if (item.image) return item.image;

    // Media content (various formats)
    if (item.media?.$?.url) return item.media.$.url;
    if (item["media:content"]?.["$"]?.url) return item["media:content"]["$"].url;
    if (item["media:thumbnail"]?.["$"]?.url) return item["media:thumbnail"]["$"].url;

    // Enclosure
    if (item.enclosure?.href && this.isImageUrl(item.enclosure.href)) {
      return item.enclosure.href;
    }
    if (item.enclosure?.url && this.isImageUrl(item.enclosure.url)) {
      return item.enclosure.url;
    }

    // Extract from content HTML
    if (typeof content === "string" && content.length > 0) {
      const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgMatch) return imgMatch[1];
    }

    // Try item's own content fields
    const itemContent = item.content?.content || item.content || item.summary?.content || "";
    if (typeof itemContent === "string" && itemContent.length > 0) {
      const imgMatch = itemContent.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgMatch) return imgMatch[1];
    }

    return null;
  }

  /**
   * Extract a clean description/summary from content
   * @param {string} content - HTML content
   * @param {Object|string} summary - Summary object or string
   * @returns {string}
   */
  extractDescription(content, summary) {
    // First try the summary
    let desc = "";
    if (typeof summary === "string") {
      desc = summary;
    } else if (summary?.content) {
      desc = summary.content;
    }

    // If no summary, extract from content
    if (!desc && typeof content === "string" && content.length > 0) {
      // Strip HTML tags and get first 300 chars
      desc = content
        .replace(/<[^>]+>/g, " ")  // Remove HTML tags
        .replace(/\s+/g, " ")       // Normalize whitespace
        .trim()
        .slice(0, 300);
      if (content.length > 300) desc += "...";
    }

    return desc;
  }

  /**
   * Extract feed metadata
   * @param {Object} parsed - Parsed feed object
   * @param {string} feedUrl - Original feed URL
   * @returns {Object}
   */
  extractFeedMeta(parsed, feedUrl) {
    return {
      title: parsed.title || "Untitled Feed",
      description: parsed.description || "",
      siteUrl: parsed.link || this.extractBaseUrl(feedUrl),
      feedUrl: feedUrl,
      imageUrl: this.extractFeedImage(parsed),
      language: parsed.language || null,
      lastBuildDate: parsed.lastBuildDate
        ? new Date(parsed.lastBuildDate)
        : null,
    };
  }

  /**
   * Extract feed image from various formats
   * @param {Object} parsed - Parsed feed
   * @returns {string|null}
   */
  extractFeedImage(parsed) {
    // Helper to get first string from value (handles arrays)
    const getString = (val) => {
      if (!val) return null;
      if (Array.isArray(val)) return val[0] || null;
      if (typeof val === "object" && val.url) return val.url;
      return typeof val === "string" ? val : null;
    };

    // RSS 2.0 image
    if (parsed.image?.url) return getString(parsed.image.url);
    if (parsed.image) return getString(parsed.image);
    // Atom icon
    if (parsed.icon) return getString(parsed.icon);
    // Atom logo
    if (parsed.logo) return getString(parsed.logo);
    // itunes:image
    if (parsed.itunes?.image) return getString(parsed.itunes.image);
    return null;
  }

  /**
   * Transform feed items to normalized format
   * @param {Array} items - Raw feed items
   * @param {string} feedUrl - Feed URL for context
   * @returns {Array}
   */
  transformItems(items, feedUrl) {
    return items.map((item) => this.transformItem(item, feedUrl));
  }

  /**
   * Transform a single feed item
   * @param {Object} item - Raw feed item
   * @param {string} feedUrl - Feed URL
   * @returns {Object}
   */
  transformItem(item, feedUrl) {
    const pubDate = this.parseDate(item.pubDate || item.isoDate);
    return {
      guid: item.guid || item.id || item.link || `${feedUrl}#${pubDate?.getTime()}`,
      title: item.title || "Untitled",
      link: item.link || null,
      description: item.contentSnippet || item.summary || "",
      content: item.contentEncoded || item.content || item.summary || "",
      author: item.creator || item.author || item["dc:creator"] || null,
      pubDate: pubDate,
      imageUrl: this.extractItemImage(item),
      categories: this.extractCategories(item),
      enclosure: this.extractEnclosure(item),
    };
  }

  /**
   * Extract image URL from item
   * @param {Object} item - Feed item
   * @returns {string|null}
   */
  extractItemImage(item) {
    // Media RSS
    if (item.media?.["$"]?.url) return item.media["$"].url;
    if (item.mediaThumbnail?.["$"]?.url) return item.mediaThumbnail["$"].url;

    // Enclosure image
    if (item.enclosure?.url && this.isImageUrl(item.enclosure.url)) {
      return item.enclosure.url;
    }

    // Extract from content
    const content = item.contentEncoded || item.content || "";
    const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];

    return null;
  }

  /**
   * Check if URL is an image
   * @param {string} url - URL to check
   * @returns {boolean}
   */
  isImageUrl(url) {
    if (!url) return false;
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];
    const lowerUrl = url.toLowerCase();
    return imageExtensions.some((ext) => lowerUrl.includes(ext));
  }

  /**
   * Extract categories/tags from item
   * @param {Object} item - Feed item
   * @returns {Array<string>}
   */
  extractCategories(item) {
    if (!item.categories) return [];
    return item.categories
      .map((cat) => (typeof cat === "string" ? cat : cat.name || cat.term))
      .filter(Boolean);
  }

  /**
   * Extract enclosure (podcast/media attachment)
   * @param {Object} item - Feed item
   * @returns {Object|null}
   */
  extractEnclosure(item) {
    if (!item.enclosure) return null;
    return {
      url: item.enclosure.url,
      type: item.enclosure.type || null,
      length: item.enclosure.length ? parseInt(item.enclosure.length, 10) : null,
    };
  }

  /**
   * Parse date from various formats
   * @param {string|Date} dateInput - Date input
   * @returns {Date|null}
   */
  parseDate(dateInput) {
    if (!dateInput) return null;
    if (dateInput instanceof Date) return dateInput;
    const parsed = new Date(dateInput);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * Extract base URL from feed URL
   * @param {string} feedUrl - Feed URL
   * @returns {string}
   */
  extractBaseUrl(feedUrl) {
    try {
      const url = new URL(feedUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      return feedUrl;
    }
  }
}
