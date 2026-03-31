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

    let { data: allProducts, error } = await supabase
  .from("products")
  .select("*")
  .eq("status", "ACTIVE")
  .eq("published", true)
  .ilike("collection_handle", `%${normalizedCollection}%`);

// 🔥 FALLBACK if empty
if (!allProducts || allProducts.length === 0) {
  console.warn("⚠️ No collection match, using fallback");

  const fallback = await supabase
    .from("products")
    .select("*")
    .eq("status", "ACTIVE")
    .eq("published", true)
    .limit(200);

  allProducts = fallback.data || [];
}

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

        if (typeof value === "string") {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [parsed];
        }

        return [value];
      } catch {
        return [String(value).replace(/[\[\]"]/g, "").trim()];
      }
    };

    const normalize = (v) => String(v || "").trim().toLowerCase();

    const sortAlpha = (arr) =>
      arr.sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );

    /* ================= FILTER PRODUCTS ================= */

    let products = allProducts.filter(p => {
      if (p.inventory_quantity > 0) return true;
      const variants = safeParse(p.variants);
      return variants.some(v => v.inventory_quantity > 0 || v.available === true);
    });

    if (vendor) {
      const list = Array.isArray(vendor) ? vendor : vendor.split(",");
      products = products.filter(p =>
        list.some(v => normalize(v) === normalize(p.vendor))
      );
    }

    if (product_type) {
      const list = Array.isArray(product_type) ? product_type : product_type.split(",");
      products = products.filter(p =>
        list.some(v => normalize(v) === normalize(p.product_type))
      );
    }

    if (fabric) {
      const list = Array.isArray(fabric) ? fabric : fabric.split(",");
      products = products.filter(p => {
        const pf = safeParse(p.fabric).map(normalize);
        return list.some(f => pf.includes(normalize(f)));
      });
    }

    if (minPrice || maxPrice) {
      products = products.filter(p => {
        const price = Number(p.price || 0);
        if (minPrice && price < Number(minPrice)) return false;
        if (maxPrice && price > Number(maxPrice)) return false;
        return true;
      });
    }

    if (color) {
      const list = Array.isArray(color) ? color : color.split(",");
      products = products.filter(p => {
        const pc = safeParse(p.color).map(normalize);
        const vc = safeParse(p.variants).map(v => normalize(v.color));
        return list.some(c =>
          pc.some(x => x.includes(normalize(c))) ||
          vc.some(x => x.includes(normalize(c)))
        );
      });
    }

    if (delivery_timeline) {
      const list = Array.isArray(delivery_timeline)
        ? delivery_timeline
        : delivery_timeline.split(",");

      products = products.filter(p => {
        const pd = safeParse(p.delivery_timeline).map(normalize);
        return list.some(t => pd.includes(normalize(t)));
      });
    }

    /* ================= FORMAT ================= */

    let formattedProducts = products.map(p => ({
      ...p,
      price: Number(p.price || 0),
      compare_at_price: Number(
        p.compare_at_price || p.compareAtPrice || p.mrp || 0
      )
    }));

    /* ================= SORT ================= */

    if (!sort_by) {
      formattedProducts.sort((a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
      );
    }

    /* ================= PAGINATION ================= */

    const currentPage = Number(page) || 1;
    const limit = 12;

    const total = formattedProducts.length;
    const totalPages = Math.ceil(total / limit);

    const paginatedProducts = formattedProducts.slice(
      (currentPage - 1) * limit,
      currentPage * limit
    );

    /* ================= FILTER BUILD ================= */

    const vendorCounts = {};
    const typeCounts = {};
    const colorCounts = {};
    const sizeAvailability = {};
    const fabricSet = new Set();
    const deliverySet = new Set();

    products.forEach(p => { // ✅ IMPORTANT CHANGE (was allProducts)
      if (p.vendor) {
        const v = String(p.vendor)
          .replace(/&/g, "and")
          .replace(/\s+/g, " ")
          .trim();
        vendorCounts[v] = (vendorCounts[v] || 0) + 1;
      }

      if (p.product_type) {
        const t = String(p.product_type).trim();
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }

      safeParse(p.color).forEach(c => {
        const clean = String(c).trim();
        if (clean) colorCounts[clean] = (colorCounts[clean] || 0) + 1;
      });

      safeParse(p.fabric).forEach(f => {
        const clean = String(f).trim();
        if (clean) fabricSet.add(clean);
      });

      safeParse(p.delivery_timeline).forEach(d => {
        const clean = String(d).replace(/[\[\]"]/g, "").trim();
        if (clean) deliverySet.add(clean);
      });

      safeParse(p.variants).forEach(v => {
        if (!v.size) return;
        if (!sizeAvailability[v.size]) sizeAvailability[v.size] = false;
        if (v.inventory_quantity > 0) sizeAvailability[v.size] = true;
      });
    });

    const parseTimeline = (text) => {
      const t = text.toLowerCase();
      if (t.includes("hour")) return parseInt(t) || 0;
      if (t.includes("week")) return (parseInt(t) || 1) * 168;
      if (t.includes("above")) return 99998;
      return 99999;
    };

    const delivery_timeline_final = [...deliverySet]
      .filter(Boolean)
      .sort((a, b) => parseTimeline(a) - parseTimeline(b));

    return res.status(200).json({
      filters: {
        vendors: sortAlpha(Object.keys(vendorCounts))
          .map(n => ({ name: n, count: vendorCounts[n] })),
        productTypes: sortAlpha(Object.keys(typeCounts))
          .map(n => ({ name: n, count: typeCounts[n] })),
        colors: sortAlpha(Object.keys(colorCounts))
          .map(n => ({ name: n, count: colorCounts[n] })),
        sizes: sortAlpha(Object.keys(sizeAvailability))
          .map(n => ({ name: n, available: sizeAvailability[n] })),
        fabrics: sortAlpha([...fabricSet]),
        delivery_timeline: delivery_timeline_final,
        priceRange: {
          min: Math.min(...formattedProducts.map(p => p.price || 0)),
          max: Math.max(...formattedProducts.map(p => p.price || 0))
        }
      },
      products: paginatedProducts,
      pagination: {
        total,
        totalPages,
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