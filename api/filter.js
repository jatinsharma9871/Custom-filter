import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {
  // ===== CORS =====
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
   const { collection, minPrice, maxPrice, vendor, product_type, color } = req.query;

    if (!collection) {
      return res.status(400).json({ error: "Collection required" });
    }

    // ---------- NORMALIZE COLLECTION ----------
    const normalizedCollection = String(collection)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "");

    console.log("COLLECTION:", normalizedCollection);

    // ---------- BASE QUERY ----------
    let query = supabase
      .from("products")
      .select("*")
      .eq("status", "ACTIVE")
      .eq("published", true)
      .gt("inventory_quantity", 0)
      .filter(
        "collection_handle",
        "cs",
        JSON.stringify([normalizedCollection])
      );

    // ---------- VENDOR FILTER ----------
    if (vendor) {
      const vendors = Array.isArray(vendor) ? vendor : vendor.split(",");
      query = query.in("vendor", vendors);
    }

    // ---------- PRODUCT TYPE FILTER ----------
    if (product_type) {
      const types = Array.isArray(product_type)
        ? product_type
        : product_type.split(",");
      query = query.in("product_type", types);
    }

    // ---------- PRICE FILTER ----------
    if (minPrice) query = query.gte("price", Number(minPrice));
    if (maxPrice) query = query.lte("price", Number(maxPrice));

    const { data: products, error } = await query;
    if (error) throw error;
/* ---------- SAFE PARSER ---------- */
function safeParse(value) {
  try {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.includes("[")) {
      return JSON.parse(value);
    }
    return [value];
  } catch {
    return [];
  }
}
/* ---------- COLOR FILTER ---------- */
/* ---------- COLOR FILTER (FIXED) ---------- */
const COLOR_GROUPS = {
  red: ["red","crimson","burgundy","wine","rust","sindoor","maroon","ruby"],
  blue: ["blue","navy","sky","azure","sapphire","teal","night blue"],
  green: ["green","emerald","olive","mint","lime","forest"],
  pink: ["pink","blush","rose","fuchsia","gum pink"],
  purple: ["purple","violet","lilac","mauve","amethyst"],
  brown: ["brown","tan","beige","cream","taupe","cinnamon","chocolate"],
  yellow: ["yellow","mustard","lemon","gold","golden"],
  black: ["black","charcoal","jet"],
  white: ["white","ivory","off white","cream"],
  grey: ["grey","gray","silver","ash"]
};
function expandColor(color) {
  const c = color.toLowerCase();

  for (let group in COLOR_GROUPS) {
    if (COLOR_GROUPS[group].includes(c)) {
      return COLOR_GROUPS[group];
    }
  }

  return [c]; // fallback
}
if (color) {

  const selectedColors = Array.isArray(color)
    ? color
    : color.split(",");

  const normalize = v => String(v).trim().toLowerCase();

  const normalizedSelected =  new Set(selectedColors.map(normalize));

  const filtered = products.filter(p => {

    // ✅ product-level colors
    const productColors = safeParse(p.color).map(normalize);

    // ✅ OPTIONAL: variant-level colors (if exists)
    const variantColors = safeParse(p.variants)
      .map(v => normalize(v?.color || v?.option1 || ""));

    return normalizedSelected.some(selected => {

      // 🔥 split multi-color (black/white)
      const parts = selected.split("/");

      return parts.some(part => {

        return (
          // ✅ partial match product
          productColors.some(pc => pc.includes(part)) ||

          // ✅ partial match variant
          variantColors.some(vc => vc.includes(part))
        );

      });

    });

  });

  products.length = 0;
  products.push(...filtered);
}
/* ---------- BUILD FILTER META ---------- */

const vendorCounts = {};
const colorCounts = {};
const typeCounts = {};
const sizeSet = new Set();
const fabricSet = new Set();
const deliverySet = new Set();

products.forEach(p => {

  /* ===== VENDOR ===== */
  if (p.vendor) {
    vendorCounts[p.vendor] =
      (vendorCounts[p.vendor] || 0) + 1;
  }

  /* ===== PRODUCT TYPE ===== */
  if (p.product_type) {
    typeCounts[p.product_type] =
      (typeCounts[p.product_type] || 0) + 1;
  }

  /* ===== COLOR ===== */
const parsedColors = safeParse(p.color);

parsedColors.forEach(c => {

  let raw = String(c).replace(/[\[\]"]/g,"").trim().toLowerCase();
  if (!raw) return;

  // capitalize for UI
  const formatted =
    raw.charAt(0).toUpperCase() + raw.slice(1);

  colorCounts[formatted] =
    (colorCounts[formatted] || 0) + 1;

  // handle multi-color
  if (raw.includes("/")) {
    raw.split("/").forEach(part => {

      const sub = part.trim().toLowerCase();
      const subFormatted =
        sub.charAt(0).toUpperCase() + sub.slice(1);

      colorCounts[subFormatted] =
        (colorCounts[subFormatted] || 0) + 1;

    });
  }

});

  /* ===== SIZE ===== */
  const sizes = safeParse(p.size);
  sizes.forEach(s => s && sizeSet.add(s.trim()));

  /* ===== FABRIC ===== */
  const fabrics = safeParse(p.fabric);
  fabrics.forEach(f => f && fabricSet.add(f.trim()));

  /* ===== DELIVERY ===== */
  const deliveries = safeParse(p.delivery_time);
  deliveries.forEach(d => d && deliverySet.add(d.trim()));

});
    // ---------- FORMAT FILTERS ----------
    const vendors = Object.entries(vendorCounts).map(([name, count]) => ({
      name,
      count
    }));

    const colors = Object.entries(colorCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const productTypes = Object.entries(typeCounts).map(([name, count]) => ({
      name,
      count
    }));

    const sizes         = [...sizeSet].sort();
    const fabrics       = [...fabricSet].sort();
    const delivery_time = [...deliverySet].sort();

    // ---------- PRICE RANGE ----------
    const prices = products.map(p => Number(p.price));
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;

    // ---------- RESPONSE ----------
    return res.status(200).json({
      filters: {
        vendors,
        productTypes,
        colors,
        sizes,
        fabrics,
        delivery_time,
        priceRange: { min, max }
      },
      products
    });
  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
