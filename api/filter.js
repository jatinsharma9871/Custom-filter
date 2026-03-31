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
    const {
      collection,
      minPrice,
      maxPrice,
      vendor,
      product_type,
      color,
      fabric,
      delivery_timeline,
      page,
      sort_by
    } = req.query;

    if (!collection) {
      return res.status(400).json({ error: "Collection required" });
    }

    const normalizedCollection = String(collection)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "");

    /* ================= FETCH ================= */

    const { data: allProducts, error } = await supabase
      .from("products")
      .select("*")
      .eq("status", "ACTIVE")
      .eq("published", true)
      .filter("collection_handle", "cs", `["${normalizedCollection}"]`);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!allProducts?.length) {
      return res.status(200).json({
        filters: {},
        products: [],
        pagination: { total: 0, totalPages: 0, currentPage: 1 }
      });
    }

    /* ================= HELPERS ================= */

    const safeParse = (value) => {
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
    };

    const parseDelivery = (val) => {
      try {
        if (!val) return [];
        if (val.includes("[")) return JSON.parse(val);
        return [val];
      } catch {
        return [val];
      }
    };

    /* ================= FILTER ================= */

    let products = allProducts.filter(p => {
      if (p.inventory_quantity > 0) return true;
      const variants = safeParse(p.variants);
      return variants.some(v => v.inventory_quantity > 0 || v.available);
    });

    if (fabric) {
      const fabrics = Array.isArray(fabric) ? fabric : fabric.split(",");
      products = products.filter(p =>
        safeParse(p.fabric).some(f =>
          fabrics.includes(f?.toLowerCase())
        )
      );
    }

    if (vendor) {
      const vendors = Array.isArray(vendor) ? vendor : vendor.split(",");
      products = products.filter(p => vendors.includes(p.vendor));
    }

    if (product_type) {
      const types = Array.isArray(product_type)
        ? product_type
        : product_type.split(",");
      products = products.filter(p => types.includes(p.product_type));
    }

    if (minPrice || maxPrice) {
      products = products.filter(p => {
        const price = Number(p.price || 0);
        if (minPrice && price < Number(minPrice)) return false;
        if (maxPrice && price > Number(maxPrice)) return false;
        return true;
      });
    }

    // ✅ COLOR FILTER (CLEAN)
    if (color) {
      const selected = Array.isArray(color) ? color : color.split(",");

      products = products.filter(p => {
        const variants = safeParse(p.variants);

        const allColors = [
          ...safeParse(p.color),
          ...variants.map(v =>
            v.color ||
            v.option1 ||
            v.option2 ||
            (v.title ? v.title.split("/")[0] : null)
          )
        ]
          .filter(Boolean)
          .map(c => c.toLowerCase().trim());

        return selected.some(sel =>
          allColors.includes(sel.toLowerCase().trim())
        );
      });
    }

    if (delivery_timeline) {
      const timelines = Array.isArray(delivery_timeline)
        ? delivery_timeline
        : delivery_timeline.split(",");

      products = products.filter(p => {
        const values = parseDelivery(p.delivery_timeline);

        return values.some(val =>
          timelines.some(t =>
            val.toLowerCase().trim() === t.toLowerCase().trim()
          )
        );
      });
    }

    /* ================= FORMAT ================= */

    let formattedProducts = products.map(p => ({
      ...p,
      price: Number(p.price || 0),
      compare_at_price: Number(
        p.compare_at_price ||
        p.compareAtPrice ||
        p.mrp ||
        0
      )
    }));

    /* ================= PAGINATION ================= */

    const currentPage = Number(page) || 1;
    const limit = 12;
    const total = formattedProducts.length;

    const paginatedProducts = formattedProducts.slice(
      (currentPage - 1) * limit,
      currentPage * limit
    );

    /* ================= FILTER BUILD ================= */

    const colorCounts = {};

    allProducts.forEach(p => {
      const variants = safeParse(p.variants);

      const allColors = [
        ...safeParse(p.color),
        ...variants.map(v =>
          v.color ||
          v.option1 ||
          v.option2 ||
          (v.title ? v.title.split("/")[0] : null)
        )
      ];

      allColors.forEach(c => {
        if (!c) return;

        const normalized = c.toLowerCase().trim();

        if (
          !normalized ||
          normalized.includes("default") ||
          normalized === "title"
        ) return;

        colorCounts[normalized] =
          (colorCounts[normalized] || 0) + 1;
      });
    });

    return res.status(200).json({
      filters: {
        colors: Object.keys(colorCounts).map(name => ({
          name: name.charAt(0).toUpperCase() + name.slice(1),
          value: name,
          count: colorCounts[name]
        }))
      },
      products: paginatedProducts,
      pagination: {
        total,
        totalPages: Math.ceil(total / limit),
        currentPage
      }
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({
      error: err.message || "Server error"
    });
  }
}