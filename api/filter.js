import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { minPrice, maxPrice, vendor, productType } = req.query;

  /* =========================
     FETCH FILTER LABELS
  ========================== */

  const { data: allProducts } = await supabase
    .from("products")
    .select("vendor, product_type, price");

  const vendors = [...new Set(allProducts.map(p => p.vendor).filter(Boolean))];
  const productTypes = [...new Set(allProducts.map(p => p.product_type).filter(Boolean))];

  const prices = allProducts.map(p => parseFloat(p.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  /* =========================
     APPLY FILTERS
  ========================== */

  let query = supabase.from("products").select("*");

  if (minPrice) query = query.gte("price", minPrice);
  if (maxPrice) query = query.lte("price", maxPrice);
  if (vendor) query = query.eq("vendor", vendor);
  if (productType) query = query.eq("product_type", productType);

  const { data: filtered, error } = await query.limit(1000);

  if (error) return res.status(500).json(error);

  res.status(200).json({
    filters: {
      vendors,
      productTypes,
      priceRange: { min, max }
    },
    products: filtered
  });
}
