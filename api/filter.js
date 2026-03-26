import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {
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

    const normalizedCollection = String(collection)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "");

    /* ================= FETCH ALL PRODUCTS ================= */

 const { data: allProducts, error } = await supabase
  .from("products")
  .select("*")
  .eq("status", "ACTIVE")
  .eq("published", true)
  .filter(
    "collection_handle",
    "cs",
    `["${normalizedCollection}"]`
  );

if (error) {
  console.error("SUPABASE ERROR:", error);
  return res.status(500).json({ error: error.message });
}



if (error) {
  console.error("SUPABASE ERROR:", error);
  return res.status(500).json({ error: error.message });
}
console.log("Collection:", normalizedCollection);
console.log("Sample data:", allProducts?.slice(0, 3));

    /* ================= SAFE PARSER ================= */

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

    /* ================= STOCK FILTER ================= */

    let products = products.filter(p => {
      if (p.inventory_quantity > 0) return true;

      const variants = safeParse(p.variants);

      return variants.some(v =>
        v.inventory_quantity > 0 || v.available === true
      );
    });

    /* ================= FABRIC FILTER ================= */

if (req.query.fabric) {
  const fabrics = Array.isArray(req.query.fabric)
    ? req.query.fabric
    : req.query.fabric.split(",");

  products = products.filter(p => {
const productFabric = safeParse(p.fabric)
  .map(f => f?.toLowerCase?.())
  .filter(Boolean);

    return fabrics.some(f =>
      productFabric.includes(f.toLowerCase())
    );
  });
}
    /* ================= VENDOR ================= */

    if (vendor) {
      const vendors = Array.isArray(vendor) ? vendor : vendor.split(",");
      products = products.filter(p => vendors.includes(p.vendor));
    }

    /* ================= PRODUCT TYPE ================= */

    if (product_type) {
      const types = Array.isArray(product_type)
        ? product_type
        : product_type.split(",");
      products = products.filter(p => types.includes(p.product_type));
    }

    /* ================= PRICE ================= */

    if (minPrice) products = products.filter(p => p.price >= Number(minPrice));
    if (maxPrice) products = products.filter(p => p.price <= Number(maxPrice));

    /* ================= COLOR FILTER ================= */

    const COLOR_GROUPS = {
      red: ["red","crimson","burgundy","wine","rust"],
      blue: ["blue","navy","sky","azure","sapphire"],
      green: ["green","emerald","olive","mint"],
      pink: ["pink","blush","rose"],
      black: ["black","charcoal"],
      white: ["white","ivory","cream"]
    };

    function expandColor(c) {
      const key = c.toLowerCase();
      for (let g in COLOR_GROUPS) {
        if (COLOR_GROUPS[g].includes(key)) return COLOR_GROUPS[g];
      }
      return [key];
    }

    if (color) {
      const selected = Array.isArray(color) ? color : color.split(",");
      const expanded = selected.flatMap(expandColor);

      products = products.filter(p => {
        const productColors = safeParse(p.color).map(c => c.toLowerCase());

        const variantColors = safeParse(p.variants)
          .map(v => (v.color || "").toLowerCase());

        return expanded.some(c =>
          productColors.some(pc => pc.includes(c)) ||
          variantColors.some(vc => vc.includes(c))
        );
      });
    }

    /* ================= FORMAT PRODUCTS ================= */

    const formattedProducts = products.map(p => ({
      ...p,
      price: Number(p.price || 0),
      compare_at_price: Number(
        p.compare_at_price ||
        p.compareAtPrice ||
        p.mrp ||
        0
      )
    }));

    /* ================= BUILD FILTERS FROM ALL PRODUCTS ================= */

    const vendorCounts = {};
    const colorCounts = {};
    const typeCounts = {};
    const sizeSet = new Set();
    const fabricSet = new Set();
    const deliverySet = new Set();

    allProducts.forEach(p => {

      if (p.vendor) vendorCounts[p.vendor] = (vendorCounts[p.vendor] || 0) + 1;
      if (p.product_type) typeCounts[p.product_type] = (typeCounts[p.product_type] || 0) + 1;

      safeParse(p.color).forEach(c => {
        const val = c.trim();
        colorCounts[val] = (colorCounts[val] || 0) + 1;
      });

      safeParse(p.size).forEach(s => sizeSet.add(s));
      safeParse(p.fabric).forEach(f => fabricSet.add(f));
      safeParse(p.delivery_time).forEach(d => deliverySet.add(d));
    });

    /* ================= SORTING ================= */

    const SIZE_ORDER = ["XXS","XS","S","M","L","XL","XXL","3XL","4XL"];

    const vendors = Object.entries(vendorCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const productTypes = Object.entries(typeCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const colors = Object.entries(colorCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const sizes = [...sizeSet].sort((a, b) =>
      SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b)
    );

    const fabrics = [...fabricSet].sort((a, b) =>
      a.localeCompare(b)
    );

    const delivery_time = [...deliverySet].sort((a, b) =>
      a.localeCompare(b)
    );

    const prices = formattedProducts.map(p => p.price);
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;

    /* ================= RESPONSE ================= */

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
      products: formattedProducts
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}