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
      delivery_timeline, // ✅ FIXED
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

    // Fabric
    if (fabric) {
      const fabrics = Array.isArray(fabric) ? fabric : fabric.split(",");
      products = products.filter(p =>
        safeParse(p.fabric).some(f =>
          fabrics.includes(f?.toLowerCase())
        )
      );
    }

    // Vendor
    if (vendor) {
      const vendors = Array.isArray(vendor) ? vendor : vendor.split(",");
      products = products.filter(p => vendors.includes(p.vendor));
    }

    // Product Type
    if (product_type) {
      const types = Array.isArray(product_type)
        ? product_type
        : product_type.split(",");
      products = products.filter(p => types.includes(p.product_type));
    }

    // Price
    if (minPrice || maxPrice) {
      products = products.filter(p => {
        const price = Number(p.price || 0);
        if (minPrice && price < Number(minPrice)) return false;
        if (maxPrice && price > Number(maxPrice)) return false;
        return true;
      });
    }

    // Color
    if (color) {
      const selected = Array.isArray(color) ? color : color.split(",");
      products = products.filter(p => {
        const productColors = safeParse(p.color).map(c => c.toLowerCase());
        const variantColors = safeParse(p.variants).map(v => (v.color || "").toLowerCase());

        return selected.some(c =>
          productColors.some(pc => pc.includes(c.toLowerCase())) ||
          variantColors.some(vc => vc.includes(c.toLowerCase()))
        );
      });
    }

    // ✅ DELIVERY TIMELINE (FIXED)
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
        formattedProducts.sort((a, b) => a.title?.localeCompare(b.title));
        break;
      case "title-descending":
        formattedProducts.sort((a, b) => b.title?.localeCompare(a.title));
        break;
      case "created-ascending":
        formattedProducts.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        break;
      default:
        formattedProducts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
      if (p.vendor) vendorCounts[p.vendor] = (vendorCounts[p.vendor] || 0) + 1;
      if (p.product_type) typeCounts[p.product_type] = (typeCounts[p.product_type] || 0) + 1;

      safeParse(p.color).forEach(c => {
        colorCounts[c] = (colorCounts[c] || 0) + 1;
      });

      safeParse(p.fabric).forEach(f => fabricSet.add(f));

      // ✅ CLEAN DELIVERY VALUES
      const values = parseDelivery(p.delivery_timeline);
      values.forEach(v => {
        if (v && v.trim()) deliverySet.add(v.trim());
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
        vendors: Object.keys(vendorCounts).map(name => ({ name, count: vendorCounts[name] })),
        productTypes: Object.keys(typeCounts).map(name => ({ name, count: typeCounts[name] })),
        colors: Object.keys(colorCounts).map(name => ({ name, count: colorCounts[name] })),
        sizes: Object.keys(sizeAvailability).map(name => ({ name, available: sizeAvailability[name] })),
        fabrics: [...fabricSet],
        delivery_time: [...deliverySet].sort(), // ✅ CLEAN
        priceRange: {
          min: Math.min(...formattedProducts.map(p => p.price)),
          max: Math.max(...formattedProducts.map(p => p.price))
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