import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {
  // ✅ CORS
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
      .toLowerCase();

    /* ================= FETCH ================= */

    const { data: allProducts, error } = await supabase
      .from("products")
      .select("*")
      .eq("status", "ACTIVE")
      .eq("published", true)
      // ✅ safer match
      .ilike("collection_handle", `%${normalizedCollection}%`);

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
          if (value.startsWith("["))
            return JSON.parse(value);
          return [value];
        }
        return [];
      } catch {
        return [];
      }
    };

    const normalize = (val) =>
      String(val || "").toLowerCase().trim();

    /* ================= FILTER ================= */

    let products = allProducts.filter(p => {
      if (p.inventory_quantity > 0) return true;

      const variants = safeParse(p.variants);
      return variants.some(v => v.inventory_quantity > 0 || v.available);
    });

    // ✅ Fabric
    if (fabric) {
      const fabrics = fabric.split(",").map(normalize);

      products = products.filter(p =>
        safeParse(p.fabric).some(f =>
          fabrics.includes(normalize(f))
        )
      );
    }

    // ✅ Vendor
    if (vendor) {
      const vendors = vendor.split(",").map(normalize);

      products = products.filter(p =>
        vendors.includes(normalize(p.vendor))
      );
    }

    // ✅ Product Type
    if (product_type) {
      const types = product_type.split(",").map(normalize);

      products = products.filter(p =>
        types.includes(normalize(p.product_type))
      );
    }

    // ✅ Price
    if (minPrice || maxPrice) {
      products = products.filter(p => {
        const price = Number(p.price || 0);

        if (minPrice && price < Number(minPrice)) return false;
        if (maxPrice && price > Number(maxPrice)) return false;

        return true;
      });
    }

    // ✅ Color (FIXED matching)
    if (color) {
      const selected = color.split(",").map(normalize);

      products = products.filter(p => {
        const productColors = safeParse(p.color).map(normalize);
        const variantColors = safeParse(p.variants).map(v =>
          normalize(v.color)
        );

        return selected.some(c =>
          productColors.includes(c) ||
          variantColors.includes(c)
        );
      });
    }

    // ✅ DELIVERY TIMELINE (FIXED STRONGLY)
    if (delivery_timeline) {
      const timelines = delivery_timeline.split(",").map(normalize);

      products = products.filter(p => {
        const values = safeParse(p.delivery_timeline).map(normalize);

        return values.some(v => timelines.includes(v));
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

    /* ================= SORT ================= */

    switch (sort_by) {
      case "manual":
        formattedProducts.sort((a, b) => (a.position || 0) - (b.position || 0));
        break;
      case "price-ascending":
        formattedProducts.sort((a, b) => a.price - b.price);
        break;
      case "price-descending":
        formattedProducts.sort((a, b) => b.price - a.price);
        break;
      case "title-ascending":
        formattedProducts.sort((a, b) =>
          (a.title || "").localeCompare(b.title || "")
        );
        break;
      case "title-descending":
        formattedProducts.sort((a, b) =>
          (b.title || "").localeCompare(a.title || "")
        );
        break;
      case "created-ascending":
        formattedProducts.sort((a, b) =>
          new Date(a.created_at) - new Date(b.created_at)
        );
        break;
      default:
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

    /* ================= BUILD FILTERS ================= */

    const vendorCounts = {};
    const typeCounts = {};
    const colorCounts = {};
    const sizeAvailability = {};
    const fabricSet = new Set();
    const deliverySet = new Set();

    allProducts.forEach(p => {
      if (p.vendor) {
        const key = p.vendor;
        vendorCounts[key] = (vendorCounts[key] || 0) + 1;
      }

      if (p.product_type) {
        const key = p.product_type;
        typeCounts[key] = (typeCounts[key] || 0) + 1;
      }

      safeParse(p.color).forEach(c => {
        colorCounts[c] = (colorCounts[c] || 0) + 1;
      });

      safeParse(p.fabric).forEach(f => fabricSet.add(f));

      safeParse(p.delivery_timeline).forEach(v => {
        if (v) deliverySet.add(v.trim());
      });

      safeParse(p.variants).forEach(v => {
        if (!v.size) return;

        if (!sizeAvailability[v.size]) sizeAvailability[v.size] = false;
        if (v.inventory_quantity > 0) sizeAvailability[v.size] = true;
      });
    });

    /* ================= RESPONSE ================= */

    return res.status(200).json({
      filters: {
        vendors: Object.keys(vendorCounts).map(name => ({
          name,
          count: vendorCounts[name]
        })),
        productTypes: Object.keys(typeCounts).map(name => ({
          name,
          count: typeCounts[name]
        })),
        colors: Object.keys(colorCounts).map(name => ({
          name,
          count: colorCounts[name]
        })),
        sizes: Object.keys(sizeAvailability).map(name => ({
          name,
          available: sizeAvailability[name]
        })),
        fabrics: [...fabricSet],
        delivery_timeline: [...deliverySet].sort(), // ✅ FIXED KEY
        priceRange: {
          min: total ? Math.min(...formattedProducts.map(p => p.price)) : 0,
          max: total ? Math.max(...formattedProducts.map(p => p.price)) : 0
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