import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PAGE_LIMIT = 12;

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
      size,
      fabric,
      delivery_timeline,
      page,
      sort_by
    } = req.query;

    const normalizedCollection = String(collection || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "") || "all";

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

    const normalize = (value) =>
      String(value || "").trim().toLowerCase();

    const toList = (value) =>
      (Array.isArray(value) ? value : String(value || "").split(","))
        .map((item) => String(item).trim())
        .filter(Boolean);

    // Escapes a value for safe use inside a PostgREST .or() filter string.
    // Commas and parentheses are meaningful in that syntax, so they're
    // stripped rather than matched literally.
   const escapeForOr = (value) =>
  String(value).replace(/[(),"\\*]/g, "");

    const variantIsAvailable = (variant) =>
      variant &&
      (Number(variant.inventory_quantity) > 0 || variant.available === true);

    const currentPage = Math.max(1, Number(page) || 1);

    /* ================= FILTER OPTIONS (from cache) ================= */

    const { data: cacheRow, error: cacheError } = await supabase
      .from("filter_cache")
      .select("filters")
      .eq("collection_handle", normalizedCollection)
      .maybeSingle();

    if (cacheError) {
      console.error("Filter cache lookup error:", cacheError);
    }

    const cachedFilters = cacheRow?.filters || null;

    /* ================= BUILD PRODUCT QUERY ================= */

    const PRODUCT_COLUMNS = `
id,
title,
handle,
vendor,
product_type,
price,
compare_at_price,
image,
images,
variants,
fabric,
color,
delivery_timeline,
inventory_quantity,
created_at,
collection_handle,
position
`;

    let query = supabase
      .from("products")
      .select(PRODUCT_COLUMNS, { count: "exact" })
   .ilike("status", "active")
      .eq("published", true);

    if (normalizedCollection && normalizedCollection !== "all") {
      query = query.filter(
        "collection_handle",
        "cs",
        `["${normalizedCollection}"]`
      );
    }

    if (vendor) {
      query = query.in("vendor", toList(vendor));
    }

    if (product_type) {
      query = query.in("product_type", toList(product_type));
    }

        if (minPrice !== undefined && minPrice !== "" && !Number.isNaN(Number(minPrice))) {
      query = query.gte("price", Number(minPrice));
    }

    if (maxPrice !== undefined && maxPrice !== "" && !Number.isNaN(Number(maxPrice))) {
      query = query.lte("price", Number(maxPrice));
    }

    // color/fabric/delivery_timeline are stored as JSON-encoded text
    // (e.g. `["Black","Blue"]`), so containment is checked with a
    // quoted-substring ILIKE match pushed down to Postgres instead of
    // pulling every row into Node to filter in memory.
    // Note: inside a PostgREST .or() filter string, "*" is the wildcard
    // (not "%") — it's an alias PostgREST provides specifically so
    // pattern characters don't collide with the filter string's own
    // reserved characters (commas, periods, etc).
    if (color) {
      const selectedColors = toList(color);
      const orExpr = selectedColors
        .map((c) => `color.ilike.*"${escapeForOr(c)}"*`)
        .join(",");
      if (orExpr) query = query.or(orExpr);
    }

    if (fabric) {
      const selectedFabrics = toList(fabric);
      const orExpr = selectedFabrics
        .map((f) => `fabric.ilike.*${escapeForOr(f)}*`)
        .join(",");
      if (orExpr) query = query.or(orExpr);
    }

    if (delivery_timeline) {
      const selectedDeliveryTimes = toList(delivery_timeline);
      const orExpr = selectedDeliveryTimes
        .map((d) => `delivery_timeline.ilike.*${escapeForOr(d)}*`)
        .join(",");
      if (orExpr) query = query.or(orExpr);
    }

    switch (sort_by) {
      case "price-ascending":
        query = query.order("price", { ascending: true });
        break;

      case "price-descending":
        query = query.order("price", { ascending: false });
        break;

      case "title-ascending":
        query = query.order("title", { ascending: true });
        break;

      case "title-descending":
        query = query.order("title", { ascending: false });
        break;

      case "created-ascending":
        query = query.order("created_at", { ascending: true });
        break;

      default:
        query = query.order("created_at", { ascending: false });
    }

    /* ================= FETCH ================= */
    // Availability check is defined here so it can run before pagination
    // in both branches below.
    const isProductAvailable = (product) => {
      if (Number(product.inventory_quantity) > 0) return true;
      return safeParse(product.variants).some(variantIsAvailable);
    };

    let allProducts, total;

    if (size) {
      const { data, error } = await query;

      if (error) {
        console.error("Supabase Error:", error);
        return res.status(500).json({ error: error.message });
      }

      const selectedSizes = toList(size).map(normalize);

      const filtered = (data || []).filter(
        (product) =>
          isProductAvailable(product) &&
          safeParse(product.variants).some(
            (variant) =>
              selectedSizes.includes(normalize(variant?.size)) &&
              variantIsAvailable(variant)
          )
      );

      total = filtered.length;
      allProducts = filtered.slice(
        (currentPage - 1) * PAGE_LIMIT,
        currentPage * PAGE_LIMIT
      );
    } else {
      // No size filter, but we still need to filter by availability
      // BEFORE paginating, so fetch unpaginated here rather than using
      // .range(). This trades DB-side pagination for correctness; if the
      // catalog is large, consider adding an availability column so this
      // can go back to being filtered in SQL with .range() again.
      const { data, error } = await query;

      if (error) {
        console.error("Supabase Error:", error);
        return res.status(500).json({ error: error.message });
      }

      const filtered = (data || []).filter(isProductAvailable);

      total = filtered.length;
      allProducts = filtered.slice(
        (currentPage - 1) * PAGE_LIMIT,
        currentPage * PAGE_LIMIT
      );
    }

    const paginatedProducts = allProducts.map((product) => ({
      ...product,
      price: Number(product.price || 0),
      compare_at_price: Number(product.compare_at_price || 0)
    }));

    const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
    /* ================= FILTERS RESPONSE ================= */

    const normalizeCachedNames = (arr) =>
      (arr || []).map((v) => (typeof v === "object" ? v : { name: v }));

    const filters = cachedFilters
      ? {
          vendors: normalizeCachedNames(cachedFilters.vendors),
          productTypes: normalizeCachedNames(cachedFilters.productTypes),
          colors: normalizeCachedNames(cachedFilters.colors),
          fabrics: cachedFilters.fabrics || [],
          delivery_timeline: cachedFilters.delivery_timeline || [],
          sizes: cachedFilters.sizes || [],
          priceRange: cachedFilters.priceRange || { min: 0, max: 0 }
        }
      : {
          vendors: [],
          productTypes: [],
          colors: [],
          fabrics: [],
          delivery_timeline: [],
          sizes: [],
          priceRange: { min: 0, max: 0 }
        };

    return res.status(200).json({
      filters,
      products: paginatedProducts,
      pagination: {
        total,
        totalPages,
        currentPage
      }
    });
  } catch (error) {
    console.error("API ERROR:", error);

    return res.status(500).json({
      error: error.message || "Server error"
    });
  }
}