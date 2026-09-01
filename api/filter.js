import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PAGE_LIMIT = 12;

// Full columns — only ever fetched for the ~12 rows on the current page.
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
position,
status,
published
`;

// Lean columns — used for the filtering/availability/pagination pass.
// Keeping this narrow is what keeps the bulk query fast; it must include
// everything isProductAvailable/isPublishedAndActive/size-filtering needs.
const FILTER_PASS_COLUMNS = `
id,
price,
variants,
inventory_quantity,
status,
published,
collection_handle
`;

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

    /* ================= FILTER OPTIONS (from cache) =================
       This is intentionally independent of the product query below.
       A slow/timed-out product fetch must never prevent the filter
       panel itself from rendering. */

    let filters = {
      vendors: [],
      productTypes: [],
      colors: [],
      fabrics: [],
      delivery_timeline: [],
      sizes: [],
      priceRange: { min: 0, max: 0 }
    };

    try {
      const { data: cacheRow, error: cacheError } = await supabase
        .from("filter_cache")
        .select("filters")
        .eq("collection_handle", normalizedCollection)
        .maybeSingle();

      if (cacheError) {
        console.error("Filter cache lookup error:", cacheError);
      }

      const cachedFilters = cacheRow?.filters || null;
      const normalizeCachedNames = (arr) =>
        (arr || []).map((v) => (typeof v === "object" ? v : { name: v }));

      if (cachedFilters) {
        filters = {
          vendors: normalizeCachedNames(cachedFilters.vendors),
          productTypes: normalizeCachedNames(cachedFilters.productTypes),
          colors: normalizeCachedNames(cachedFilters.colors),
          fabrics: cachedFilters.fabrics || [],
          delivery_timeline: cachedFilters.delivery_timeline || [],
          sizes: cachedFilters.sizes || [],
          priceRange: cachedFilters.priceRange || { min: 0, max: 0 }
        };
      }
    } catch (err) {
      // Never let a filter_cache problem take down the whole response.
      console.error("Filter cache fetch threw:", err);
    }

    /* ================= BUILD PRODUCT QUERY (helper) ================= */

    const buildQuery = (columns) => {
      let query = supabase
        .from("products")
        .select(columns, { count: "exact" })
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
      // NOTE: these are leading-wildcard ILIKE scans and are the main
      // remaining cost in this query. Converting color/fabric/
      // delivery_timeline to real jsonb/text[] columns with a GIN index
      // (and switching these to .contains()/.overlaps()) would remove
      // this cost entirely — recommended as a follow-up.
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

      return query;
    };

    /* ================= FETCH PRODUCTS (own try/catch) ================= */

    const isProductAvailable = (product) => {
      if (Number(product.inventory_quantity) > 0) return true;
      return safeParse(product.variants).some(variantIsAvailable);
    };

    // Safety net: even though the query already filters status/published,
    // this guarantees a draft/unpublished row can NEVER reach the response,
    // regardless of inconsistent DB values (casing, string "true", nulls, etc.)
    // or a bug anywhere upstream.
    const isPublishedAndActive = (product) => {
      const status = String(product.status || "").trim().toLowerCase();
      const published =
        product.published === true || product.published === "true";
      return status === "active" && published;
    };

    let paginatedProducts = [];
    let total = 0;
    let productsError = null;

    try {
      // Lean pass: fetch only what's needed to determine availability,
      // size match, and pagination — NOT full row data. This is the
      // pass most exposed to statement timeouts, so keep its payload
      // as small as possible.
      const { data, error } = await buildQuery(FILTER_PASS_COLUMNS);

      if (error) throw error;

      let filteredIds;

      if (size) {
        const selectedSizes = toList(size).map(normalize);

        filteredIds = (data || [])
          .filter(
            (product) =>
              isPublishedAndActive(product) &&
              isProductAvailable(product) &&
              safeParse(product.variants).some(
                (variant) =>
                  selectedSizes.includes(normalize(variant?.size)) &&
                  variantIsAvailable(variant)
              )
          )
          .map((p) => p.id);
      } else {
        filteredIds = (data || [])
          .filter(
            (product) => isPublishedAndActive(product) && isProductAvailable(product)
          )
          .map((p) => p.id);
      }

      total = filteredIds.length;

      const pageIds = filteredIds.slice(
        (currentPage - 1) * PAGE_LIMIT,
        currentPage * PAGE_LIMIT
      );

      if (pageIds.length) {
        // Full-detail pass: only for the ~12 ids on this page, fetched
        // by primary key (cheap and index-backed regardless of catalog size).
        const { data: fullData, error: fullError } = await supabase
          .from("products")
          .select(PRODUCT_COLUMNS)
          .in("id", pageIds);

        if (fullError) throw fullError;

        // .in() doesn't preserve order, so restore the sort order that
        // the lean pass already established.
        const byId = new Map((fullData || []).map((p) => [p.id, p]));
        paginatedProducts = pageIds
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((product) => {
            const { status, published, ...rest } = product;
            return {
              ...rest,
              price: Number(product.price || 0),
              compare_at_price: Number(product.compare_at_price || 0)
            };
          });
      }
    } catch (err) {
      console.error("Product query error:", err);
      productsError = err.message || "Failed to load products";
      // Deliberately not returning here — filters above are still valid
      // and should still reach the client.
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

    return res.status(200).json({
      filters,
      products: paginatedProducts,
      pagination: {
        total,
        totalPages,
        currentPage
      },
      ...(productsError ? { productsError } : {})
    });
  } catch (error) {
    console.error("API ERROR:", error);

    return res.status(500).json({
      error: error.message || "Server error"
    });
  }
}