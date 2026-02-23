import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {

  /* ================= HEADERS ================= */

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  try {

    const { collection, minPrice, maxPrice } = req.query;
    let { vendor } = req.query;

    if (!collection) {
      return res.status(400).json({ error: "Collection required" });
    }

    /* =========================
       NORMALIZE PARAMS
    ========================== */

    if (typeof vendor === "string" && vendor.includes(",")) {
      vendor = vendor.split(",");
    }

    /* =========================
       FETCH COLLECTION PRODUCTS
       ⭐ USING collection_handle
    ========================== */

    const { data: allProducts, error: metaError } = await supabase
      .from("products")
      .select("*")
      .eq("collection_handle", collection);

    if (metaError) throw metaError;

    if (!allProducts?.length) {
      return res.status(200).json({
        filters: {
          vendors: [],
          priceRange: { min: 0, max: 0 }
        },
        products: []
      });
    }

    /* =========================
       BUILD FILTER META
    ========================== */

    const vendors = [
      ...new Set(allProducts.map(p => p.vendor).filter(Boolean))
    ];

    const prices = allProducts
      .map(p => Number(p.price))
      .filter(n => !isNaN(n));

    const min = Math.min(...prices);
    const max = Math.max(...prices);

    /* =========================
       APPLY FILTERS
    ========================== */

    let query = supabase
      .from("products")
      .select("*")
      .eq("collection_handle", collection);

    if (minPrice) query = query.gte("price", minPrice);
    if (maxPrice) query = query.lte("price", maxPrice);

    if (vendor) {
      query = Array.isArray(vendor)
        ? query.in("vendor", vendor)
        : query.eq("vendor", vendor);
    }

    const { data: filtered, error } = await query;
    if (error) throw error;

    /* =========================
       RESPONSE
    ========================== */

    return res.status(200).json({
      filters: {
        vendors,
        priceRange: { min, max }
      },
      products: filtered
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}