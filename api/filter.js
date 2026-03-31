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
      delivery_timeline, // ✅ NEW
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

    /* ================= FETCH PRODUCTS ================= */

    const { data: allProducts, error } = await supabase
      .from("products")
      .select("*")
      .eq("status", "ACTIVE")
      .eq("published", true)
      .eq("collection_handle", normalizedCollection)

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!allProducts || !allProducts.length) {
      return res.status(200).json({
        filters: {},
        products: [],
        pagination: { total: 0, totalPages: 0, currentPage: 1 }
      });
    }

    /* ================= SAFE PARSER ================= */

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

    /* ================= FILTER PRODUCTS ================= */

    let products = allProducts.filter(p => {
      if (p.inventory_quantity > 0) return true;
      const variants = safeParse(p.variants);
      return variants.some(v => v.inventory_quantity > 0 || v.available === true);
    });

    // Fabric
    if (fabric) {
      const fabrics = Array.isArray(fabric) ? fabric : fabric.split(",");
      products = products.filter(p => {
        const productFabric = safeParse(p.fabric)
          .map(f => f?.toLowerCase?.())
          .filter(Boolean);

        return fabrics.some(f =>
          productFabric.includes(f.toLowerCase())
        );
      });
    }

    // Vendor
    if (vendor) {
      const vendors = Array.isArray(vendor) ? vendor : vendor.split(",");
      products = products.filter(p => vendors.includes(p.vendor));
    }

    // Product type
    if (product_type) {
      const types = Array.isArray(product_type)
        ? product_type
        : product_type.split(",");
      products = products.filter(p => types.includes(p.product_type));
    }

    // Price
    const hasMin = minPrice && Number(minPrice) > 0;
    const hasMax = maxPrice && Number(maxPrice) > 0;

    if (hasMin || hasMax) {
      products = products.filter(p => {
        const price = Number(p.price || 0);
        if (hasMin && price < Number(minPrice)) return false;
        if (hasMax && price > Number(maxPrice)) return false;
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

    // ✅ DELIVERY TIMELINE FILTER
    if (delivery_timeline) {
      const timelines = Array.isArray(delivery_timeline)
        ? delivery_timeline
        : delivery_timeline.split(",");

     products = products.filter(p =>
  timelines.some(t =>
    (p.delivery_timeline || "")
      .toLowerCase()
      .includes(t.toLowerCase())
  )
);
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

    if (!sort_by) {
      formattedProducts.sort((a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
      );
    } else {
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
            a.title?.localeCompare(b.title)
          );
          break;
        case "title-descending":
          formattedProducts.sort((a, b) =>
            b.title?.localeCompare(a.title)
          );
          break;
        case "created-descending":
          formattedProducts.sort((a, b) =>
            new Date(b.created_at) - new Date(a.created_at)
          );
          break;
        case "created-ascending":
          formattedProducts.sort((a, b) =>
            new Date(a.created_at) - new Date(b.created_at)
          );
          break;
      }
    }

    /* ================= PAGINATION ================= */

    const currentPage = Number(page) || 1;
    const limit = 12;

    const start = (currentPage - 1) * limit;
    const end = start + limit;

    const total = formattedProducts.length;
    const totalPages = Math.ceil(total / limit);

    const paginatedProducts = formattedProducts.slice(start, end);

    /* ================= BUILD FILTERS ================= */

    const vendorCounts = {};
    const typeCounts = {};
    const colorCounts = {};
    const sizeAvailability = {};
    const fabricSet = new Set();
    const deliverySet = new Set(); // ✅ NEW

    allProducts.forEach(p => {
      if (p.vendor) vendorCounts[p.vendor] = (vendorCounts[p.vendor] || 0) + 1;
      if (p.product_type) typeCounts[p.product_type] = (typeCounts[p.product_type] || 0) + 1;

      safeParse(p.color).forEach(c => {
        colorCounts[c] = (colorCounts[c] || 0) + 1;
      });

      safeParse(p.fabric).forEach(f => fabricSet.add(f));

      // ✅ DELIVERY COLLECT
     if (p.delivery_timeline && p.delivery_timeline.trim() !== "") {
  deliverySet.add(p.delivery_timeline.trim());
} else {
  deliverySet.add("Standard Delivery"); // 🔥 TEMP FIX
}


      safeParse(p.variants).forEach(v => {
        if (!v.size) return;
        if (!sizeAvailability[v.size]) sizeAvailability[v.size] = false;
        if (v.inventory_quantity > 0) sizeAvailability[v.size] = true;
      });
    });

    const vendors = Object.keys(vendorCounts).map(name => ({ name, count: vendorCounts[name] }));
    const productTypes = Object.keys(typeCounts).map(name => ({ name, count: typeCounts[name] }));
    const colors = Object.keys(colorCounts).map(name => ({ name, count: colorCounts[name] }));
    const sizes = Object.keys(sizeAvailability).map(name => ({ name, available: sizeAvailability[name] }));
    const fabrics = [...fabricSet];
    const delivery_timeline = [...deliverySet]; // ✅ NEW

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
        delivery_timeline, // ✅ NEW
        priceRange: { min, max }
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