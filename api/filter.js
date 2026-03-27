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
const availableProducts = allProducts.filter(p => {
  if (p.inventory_quantity > 0) return true;

  const variants = safeParse(p.variants);

  return variants.some(v =>
    v.inventory_quantity > 0 || v.available === true
  );
});
    let products = [...allProducts]; // initialize first

products = products.filter(p => {
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

   const hasMin = minPrice !== undefined && minPrice !== "" && Number(minPrice) > 0;
const hasMax = maxPrice !== undefined && maxPrice !== "" && Number(maxPrice) > 0;

if (hasMin || hasMax) {
  products = products.filter(p => {
    const price = Number(p.price || 0);

    if (hasMin && price < Number(minPrice)) return false;
    if (hasMax && price > Number(maxPrice)) return false;

    return true;
  });
}
if (!allProducts || !allProducts.length) {
  return res.status(200).json({
    filters: {
      vendors: [],
      productTypes: [],
      colors: [],
      sizes: [],
      fabrics: [],
      delivery_time: [],
      priceRange: { min: 0, max: 0 }
    },
    products: []
  });
}

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

const page = Number(req.query.page) || 1;
const limit = Number(req.query.limit) || 12;

const start = (page - 1) * limit;
const end = start + limit;

const total = formattedProducts.length;
const totalPages = Math.ceil(total / limit);

const paginatedProducts = formattedProducts.slice(start, end);
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

      availableProducts.forEach(p => {
  const variants = safeParse(p.variants);

  variants.forEach(v => {
    if (v.inventory_quantity > 0) {
      if (v.size) sizeSet.add(v.size);
    }
  });
});
      safeParse(p.fabric).forEach(f => fabricSet.add(f));
      safeParse(p.delivery_time).forEach(d => deliverySet.add(d));
    });
    const sizeAvailability = {};

allProducts.forEach(p => {
  const variants = safeParse(p.variants);

  variants.forEach(v => {
    const size = v.size;
    if (!size) return;

    if (!sizeAvailability[size]) {
      sizeAvailability[size] = false;
    }

    if (v.inventory_quantity > 0) {
      sizeAvailability[size] = true;
    }
  });
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

   const sizeAvailability = {};

allProducts.forEach(p => {
  const variants = safeParse(p.variants);

  variants.forEach(v => {
    const size = v.size;
    if (!size) return;

    if (!sizeAvailability[size]) {
      sizeAvailability[size] = false;
    }

    if (v.inventory_quantity > 0) {
      sizeAvailability[size] = true;
    }
  });
});

const sizes = Object.keys(sizeAvailability).map(s => ({
  name: s,
  available: sizeAvailability[s]
}));

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
     products: paginatedProducts,
pagination: {
  total,
  totalPages,
  currentPage: page
}
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}