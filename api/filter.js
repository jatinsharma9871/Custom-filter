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
    const { collection, minPrice, maxPrice, vendor, product_type } = req.query;

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

    // ---------- BUILD FILTER META ----------
    const vendorCounts  = {};
    const colorCounts   = {};
    const typeCounts    = {};
    const sizeSet       = new Set();
    const fabricSet     = new Set();
    const deliverySet   = new Set();

    products.forEach(p => {
      // ===== VENDOR =====
      if (p.vendor) {
        vendorCounts[p.vendor] = (vendorCounts[p.vendor] || 0) + 1;
      }

      // ===== PRODUCT TYPE =====
      if (p.product_type) {
        typeCounts[p.product_type] = (typeCounts[p.product_type] || 0) + 1;
      }

      // ===== COLOR =====
      if (p.color) {
        let colors = [];
        if (Array.isArray(p.color)) {
          colors = p.color;
        } else if (typeof p.color === "string" && p.color.includes("[")) {
          try {
            colors = JSON.parse(p.color);
          } catch {
            colors = [p.color];
          }
        } else {
          colors = [p.color];
        }

        colors.forEach(c => {
          const raw = c.replace(/[\[\]"]/g, "").trim();
          if (!raw) return;

          colorCounts[raw] = (colorCounts[raw] || 0) + 1;

          if (raw.includes("/")) {
            raw.split("/").forEach(part => {
              const color = part.trim();
              if (!color) return;
              colorCounts[color] = (colorCounts[color] || 0) + 1;
            });
          }
        });
      }

      // ===== SIZE =====
      if (p.size) {
        let sizes = [];
        if (Array.isArray(p.size)) {
          sizes = p.size;
        } else if (typeof p.size === "string" && p.size.includes("[")) {
          try {
            sizes = JSON.parse(p.size);
          } catch {
            sizes = [p.size];
          }
        } else {
          sizes = [p.size];
        }

        sizes.forEach(s => {
          if (s) sizeSet.add(String(s).trim());
        });
      }

      // ===== FABRIC =====
      if (p.fabric) {
        (Array.isArray(p.fabric) ? p.fabric : [p.fabric]).forEach(f => {
          if (f) fabricSet.add(String(f).trim());
        });
      }

      // ===== DELIVERY =====
      if (p.delivery_time) {
        (Array.isArray(p.delivery_time) ? p.delivery_time : [p.delivery_time])
          .forEach(d => {
            if (d) deliverySet.add(String(d).trim());
          });
      }
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
