import { ObjectId } from "mongodb";
import { formatItem } from "../utils.js";

export const itemsController = {
  /**
   * List feed items with pagination
   * GET /api/items
   * Query: page, limit, feedId, includeContent
   */
  async list(request, response) {
    try {
      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.status(500).json({ error: "Database not available" });
      }

      const page = Math.max(1, parseInt(request.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit) || 20));
      const feedId = request.query.feedId;
      const includeContent = request.query.includeContent === "true";
      const skip = (page - 1) * limit;

      const itemsCollection = db.collection("rssItems");

      // Build query
      const query = {};
      if (feedId && ObjectId.isValid(feedId)) {
        query.feedId = new ObjectId(feedId);
      }

      // Get total count
      const total = await itemsCollection.countDocuments(query);

      // Get items
      const items = await itemsCollection
        .find(query)
        .sort({ pubDate: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const totalPages = Math.ceil(total / limit);

      response.json({
        items: items.map((item) =>
          formatItem(item, { includeContent })
        ),
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      });
    } catch (error) {
      console.error("[RSS] Error listing items:", error.message);
      response.status(500).json({ error: error.message });
    }
  },

  /**
   * Get a single item by ID
   * GET /api/items/:id
   */
  async get(request, response) {
    try {
      const { id } = request.params;

      if (!ObjectId.isValid(id)) {
        return response.status(400).json({ error: "Invalid item ID" });
      }

      const db = request.app.locals.application.getRssDb?.();
      if (!db) {
        return response.status(500).json({ error: "Database not available" });
      }

      const itemsCollection = db.collection("rssItems");
      const item = await itemsCollection.findOne({ _id: new ObjectId(id) });

      if (!item) {
        return response.status(404).json({ error: "Item not found" });
      }

      response.json({
        item: formatItem(item, { includeContent: true }),
      });
    } catch (error) {
      console.error("[RSS] Error getting item:", error.message);
      response.status(500).json({ error: error.message });
    }
  },
};
