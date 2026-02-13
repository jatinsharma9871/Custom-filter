import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

function formatCollection(handle) {
  // convert: mini-bags → Mini Bags
  return handle
    .split("-")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  try {

    const { collection, minPrice, maxPrice, vendor, productType } = req.query;

    if (!collection) {
      return res.status(400).json({ error: "Collection required" });
    }

    
    const formattedCollection = formatCollection(collection);

    /* =========================
       FETCH COLLECTION PRODUCTS
    ========================== */

    const { data: allProducts, error: metaError } = await supabase
      .from("products")
      .select("vendor, product_type, price")
   .ilike("product_type", formattedCollection)


    if (metaError) throw metaError;

    const vendors = [...new Set(allProducts.map(p => p.vendor).filter(Boolean))];
    const productTypes = [...new Set(allProducts.map(p => p.product_type).filter(Boolean))];

    const prices = allProducts.map(p => parseFloat(p.price));
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;

    /* =========================
       APPLY FILTERS
    ========================== */

    let query = supabase
      .from("products")
      .select("*")
      .eq("product_type", formattedCollection);

    if (minPrice) query = query.gte("price", minPrice);
    if (maxPrice) query = query.lte("price", maxPrice);
    if (vendor) query = query.eq("vendor", vendor);

    const { data: filtered, error } = await query.limit(1000);

    if (error) throw error;

    return res.status(200).json({
      filters: {
        vendors,
        productTypes,
        priceRange: { min, max }
      },
      products: filtered
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
