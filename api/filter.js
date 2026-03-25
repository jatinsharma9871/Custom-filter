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

    // ===== BASE QUERY =====
    let query = supabase
      .from("products")
      .select("*")
      .eq("status", "ACTIVE")
      .eq("published", true)
      .filter(
        "collection_handle",
        "cs",
        JSON.stringify([normalizedCollection])
      );

    // ===== VENDOR =====
    if (vendor) {
      const vendors = Array.isArray(vendor) ? vendor : vendor.split(",");
      query = query.in("vendor", vendors);
    }

    // ===== PRODUCT TYPE =====
    if (product_type) {
      const types = Array.isArray(product_type)
        ? product_type
        : product_type.split(",");
      query = query.in("product_type", types);
    }

    // ===== PRICE =====
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

    /* ---------- 🔥 STOCK FILTER (FIXED) ---------- */
    const inStockProducts = products.filter(p => {
      if (p.inventory_quantity > 0) return true;

      const variants = safeParse(p.variants);

      if (variants.length) {
        return variants.some(v =>
          v.inventory_quantity > 0 || v.available === true
        );
      }

      return false;
    });

    products.length = 0;
    products.push(...inStockProducts);

    /* ---------- COLOR GROUPS ---------- */
    const COLOR_GROUPS = {
      red: ["red","crimson","burgundy","wine","rust","sindoor","maroon","ruby"],
      blue: ["blue","navy","sky","azure","sapphire","teal"],
      green: ["green","emerald","olive","mint","lime","forest"],
      pink: ["pink","blush","rose","fuchsia"],
      purple: ["purple","violet","lilac","mauve","amethyst"],
      brown: ["brown","tan","beige","cream","taupe"],
      yellow: ["yellow","mustard","lemon","gold"],
      black: ["black","charcoal","jet"],
      white: ["white","ivory","off white","cream"],
      grey: ["grey","gray","silver"]
    };

    function expandColor(color) {
      const c = color.toLowerCase();
      for (let group in COLOR_GROUPS) {
        if (COLOR_GROUPS[group].includes(c)) {
          return COLOR_GROUPS[group];
        }
      }
      return [c];
    }

    /* ---------- COLOR FILTER ---------- */
    if (color) {

      const selectedColors = Array.isArray(color)
        ? color
        : color.split(",");

      const normalize = v => String(v).trim().toLowerCase();

      const expandedSelected = selectedColors.flatMap(c => expandColor(c));

      function matchProducts(colorList) {
        return products.filter(p => {

          const productColors = safeParse(p.color).map(normalize);

          const variantColors = safeParse(p.variants)
            .map(v => normalize(v?.color || v?.option1 || ""));

          return colorList.some(selected =>
            productColors.some(pc => pc.includes(selected)) ||
            variantColors.some(vc => vc.includes(selected))
          );

        });
      }

      let filtered = matchProducts(expandedSelected);

      if (filtered.length === 0) {
        filtered = matchProducts(selectedColors.map(normalize));
      }

      products.length = 0;
      products.push(...filtered);
    }

    /* ---------- 🔥 FORMAT PRODUCTS ---------- */
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

    /* ---------- BUILD FILTER META ---------- */
    const vendorCounts = {};
    const colorCounts = {};
    const typeCounts = {};
    const sizeSet = new Set();
    const fabricSet = new Set();
    const deliverySet = new Set();

    formattedProducts.forEach(p => {

      if (p.vendor) {
        vendorCounts[p.vendor] =
          (vendorCounts[p.vendor] || 0) + 1;
      }

      if (p.product_type) {
        typeCounts[p.product_type] =
          (typeCounts[p.product_type] || 0) + 1;
      }

      safeParse(p.color).forEach(c => {
        let raw = String(c).toLowerCase().trim();
        if (!raw) return;

        const formatted =
          raw.charAt(0).toUpperCase() + raw.slice(1);

        colorCounts[formatted] =
          (colorCounts[formatted] || 0) + 1;
      });

      safeParse(p.size).forEach(s => s && sizeSet.add(s));
      safeParse(p.fabric).forEach(f => f && fabricSet.add(f));
      safeParse(p.delivery_time).forEach(d => d && deliverySet.add(d));

    });

    const vendors = Object.entries(vendorCounts).map(([name, count]) => ({ name, count }));
    const colors = Object.entries(colorCounts).map(([name, count]) => ({ name, count }));
    const productTypes = Object.entries(typeCounts).map(([name, count]) => ({ name, count }));

    const prices = formattedProducts.map(p => p.price);
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;

    return res.status(200).json({
      filters: {
        vendors,
        productTypes,
        colors,
        sizes: [...sizeSet],
        fabrics: [...fabricSet],
        delivery_time: [...deliverySet],
        priceRange: { min, max }
      },
      products: formattedProducts
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}