import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
res.setHeader("Pragma", "no-cache");
res.setHeader("Expires", "0");


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
       FETCH ALL COLLECTION PRODUCTS
    ========================== */

  const { data: allProducts, error: metaError } = await supabase
  .from("products")
  .select("*")
  .ilike("product_type", collection);

      

    if (metaError) throw metaError;

    if (!allProducts || allProducts.length === 0) {
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

    const vendors = [...new Set(allProducts.map(p => p.vendor).filter(Boolean))];

    const prices = allProducts.map(p => parseFloat(p.price));
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    /* =========================
       APPLY FILTERS
    ========================== */

   let query = supabase
  .from("products")
  .select("*")
 .ilike("product_type", collection.replace(/-/g, " "));


    

    if (minPrice) query = query.gte("price", minPrice);
    if (maxPrice) query = query.lte("price", maxPrice);

    if (vendor) {
      if (Array.isArray(vendor)) {
        query = query.in("vendor", vendor);
      } else {
        query = query.eq("vendor", vendor);
      }
    }

    const { data: filtered, error } = await query;

    if (error) throw error;

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
