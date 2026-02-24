import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {

  /* ===== CORS ===== */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    const { collection, minPrice, maxPrice, vendor } = req.query;

    if (!collection) {
      return res.status(400).json({ error: "Collection required" });
    }

    /* ---------- NORMALIZE ---------- */
    const normalizedCollection = String(collection).toLowerCase();

    /* ---------- BASE QUERY ---------- */
    let query = supabase
      .from("products")
      .select("*")
   .contains("collection_handle", [normalizedCollection])

    /* ---------- PRICE FILTER ---------- */
    if (minPrice) query = query.gte("price", minPrice);
    if (maxPrice) query = query.lte("price", maxPrice);

    /* ---------- VENDOR FILTER ---------- */
    if (vendor) {
      const vendors = Array.isArray(vendor)
        ? vendor
        : vendor.split(",");
      query = query.in("vendor", vendors);
    }

    const { data: products, error } = await query;

    if (error) throw error;

    /* ---------- BUILD FILTER META ---------- */
    const vendors = [
      ...new Set(products.map(p => p.vendor).filter(Boolean))
    ];

    const prices = products.map(p => Number(p.price));

    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;

    return res.status(200).json({
      filters: {
        vendors,
        priceRange: { min, max }
      },
      products
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({
      error: err.message
    });
  }
}