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

    const { collection, minPrice, maxPrice, vendor, product_type } = req.query;

    if (!collection) {
      return res.status(400).json({ error: "Collection required" });
    }

    /* ---------- NORMALIZE ---------- */
   const normalizedCollection = String(collection || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-_]/g, "");

    /* ---------- BASE QUERY ---------- */
    console.log("COLLECTION:", normalizedCollection);
   /* ---------- BASE QUERY ---------- */
let query = supabase
  .from("products")
  .select("*")
  .eq("status", "active")
  .eq("published", true)
  .gt("inventory_quantity", 0);

if (collection) {
  query = query.filter(
    "collection_handle",
    "cs",
    JSON.stringify([normalizedCollection])
  );
}

if (vendor) {
  const vendors = Array.isArray(vendor)
    ? vendor
    : vendor.split(",");
  query = query.in("vendor", vendors);
}

if (req.query.product_type) {
  const types = Array.isArray(req.query.product_type)
    ? req.query.product_type
    : req.query.product_type.split(",");
  query = query.in("product_type", types);
}

if (minPrice) query = query.gte("price", Number(minPrice));
if (maxPrice) query = query.lte("price", Number(maxPrice));
    const { data: products, error } = await query;

    if (error) throw error;

    /* ---------- BUILD FILTER META ---------- */
  const vendorCounts = {};
const colorCounts = {};

products.forEach(p => {

  let productColors = [];

  if (p.option1_name?.toLowerCase() === "color")
    productColors.push(p.option1);

  if (p.option2_name?.toLowerCase() === "color")
    productColors.push(p.option2);

  if (p.option3_name?.toLowerCase() === "color")
    productColors.push(p.option3);

  productColors.forEach(c => {
    if (!c) return;
    colorCounts[c] = (colorCounts[c] || 0) + 1;
  });

});

const colors = Object.entries(colorCounts).map(([name, count]) => ({
  name,
  count
}));

products.forEach(p => {
  if (!p.vendor) return;

  vendorCounts[p.vendor] = (vendorCounts[p.vendor] || 0) + 1;
});

const vendors = Object.entries(vendorCounts).map(([name, count]) => ({
  name,
  count
}));
    const productTypes = [
  ...new Set(products.map(p => p.product_type).filter(Boolean))
];

    const prices = products.map(p => Number(p.price));

    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;

  return res.status(200).json({
  filters: {
    vendors,
    productTypes,
    colors,
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