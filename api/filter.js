import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PAGE_LIMIT = 12;
const MAX_PAGE_SIZE = 100;

// =========================================================
// FULL PRODUCT RESPONSE COLUMNS
// =========================================================
//
// The RPC returns the complete product row.
// We remove internal fields before sending to Shopify frontend.
//
// =========================================================

const INTERNAL_FIELDS = new Set([
  "status",
  "published",
  "manual_position",
  "total_count"
]);

// =========================================================
// HELPERS
// =========================================================

const toList = (value) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  const values = Array.isArray(value)
    ? value
    : String(value).split(",");

  return values
    .map((item) => String(item).trim())
    .filter(Boolean);
};

const normalize = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const normalizeCollection = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "") || "all";

const normalizeSort = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const parseNumber = (value) => {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
};

const parsePage = (value) => {
  const page = Number(value);

  if (!Number.isFinite(page)) {
    return 1;
  }

  return Math.max(1, Math.floor(page));
};

const sanitizeProduct = (product) => {
  if (!product || typeof product !== "object") {
    return product;
  }

  const cleaned = {};

  for (const [key, value] of Object.entries(product)) {
    if (!INTERNAL_FIELDS.has(key)) {
      cleaned[key] = value;
    }
  }

  return {
    ...cleaned,

    price: Number(product.price || 0),

    compare_at_price: Number(
      product.compare_at_price || 0
    )
  };
};

// =========================================================
// FILTER CACHE
// =========================================================
//
// This remains independent from the product query.
// A product-query failure won't prevent filters rendering.
//
// =========================================================

async function getFilters(collection) {
  const defaultFilters = {
    vendors: [],
    productTypes: [],
    colors: [],
    fabrics: [],
    delivery_timeline: [],
    sizes: [],
    priceRange: {
      min: 0,
      max: 0
    }
  };

  try {
    const {
      data: cacheRow,
      error
    } = await supabase
      .from("filter_cache")
      .select("filters")
      .eq("collection_handle", collection)
      .maybeSingle();

    if (error) {
      console.error(
        "Filter cache lookup error:",
        error
      );

      return defaultFilters;
    }

    const cachedFilters = cacheRow?.filters;

    if (!cachedFilters) {
      return defaultFilters;
    }

    const normalizeCachedNames = (array) =>
      (array || []).map((value) =>
        typeof value === "object"
          ? value
          : { name: value }
      );

    return {
      vendors: normalizeCachedNames(
        cachedFilters.vendors
      ),

      productTypes: normalizeCachedNames(
        cachedFilters.productTypes
      ),

      colors: normalizeCachedNames(
        cachedFilters.colors
      ),

      fabrics:
        cachedFilters.fabrics || [],

      delivery_timeline:
        cachedFilters.delivery_timeline || [],

      sizes:
        cachedFilters.sizes || [],

      priceRange:
        cachedFilters.priceRange || {
          min: 0,
          max: 0
        }
    };
  } catch (error) {
    console.error(
      "Filter cache fetch threw:",
      error
    );

    return defaultFilters;
  }
}

// =========================================================
// SUPABASE RPC
// =========================================================

async function fetchProducts({
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
}) {
  const vendors = toList(vendor);

  const productTypes = toList(product_type);

  const colors = toList(color);

  const sizes = toList(size);

  const fabrics = toList(fabric);

  const deliveryTimeline = toList(
    delivery_timeline
  );

  const safePage = parsePage(page);

  const safeLimit = PAGE_LIMIT;

  const safeSort = normalizeSort(sort_by);

  const parsedMinPrice = parseNumber(
    minPrice
  );

  const parsedMaxPrice = parseNumber(
    maxPrice
  );

  console.log(
    "FILTER RPC REQUEST:",
    {
      collection,
      page: safePage,
      limit: safeLimit,
      sort: safeSort,
      vendors,
      productTypes,
      colors,
      sizes,
      fabrics,
      deliveryTimeline,
      minPrice: parsedMinPrice,
      maxPrice: parsedMaxPrice
    }
  );

  const {
    data,
    error
  } = await supabase.rpc(
    "filter_products",
    {
      p_collection: collection,

      p_min_price:
        parsedMinPrice,

      p_max_price:
        parsedMaxPrice,

      p_vendors:
        vendors.length
          ? vendors
          : null,

      p_product_types:
        productTypes.length
          ? productTypes
          : null,

      p_colors:
        colors.length
          ? colors
          : null,

      p_sizes:
        sizes.length
          ? sizes
          : null,

      p_fabrics:
        fabrics.length
          ? fabrics
          : null,

      p_delivery_timeline:
        deliveryTimeline.length
          ? deliveryTimeline
          : null,

      p_page: safePage,

      p_limit: safeLimit,

      p_sort_by: safeSort
    }
  );

  if (error) {
    console.error(
      "Supabase filter_products RPC error:",
      error
    );

    throw error;
  }

  const row = Array.isArray(data)
    ? data[0]
    : data;

  const products =
    Array.isArray(row?.products)
      ? row.products
      : [];

  const total =
    Number(row?.total || 0);

  return {
    products: products.map(
      sanitizeProduct
    ),

    total,

    currentPage: safePage
  };
}

// =========================================================
// API HANDLER
// =========================================================

export default async function handler(
  req,
  res
) {
  // =======================================================
  // CORS
  // =======================================================

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  // =======================================================
  // OPTIONS
  // =======================================================

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // =======================================================
  // ONLY GET
  // =======================================================

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    // =====================================================
    // READ QUERY PARAMS
    // =====================================================

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

    // =====================================================
    // NORMALIZE COLLECTION
    // =====================================================

    const normalizedCollection =
      normalizeCollection(
        collection
      );

    // =====================================================
    // NORMALIZE SORT
    // =====================================================

    const normalizedSort =
      normalizeSort(sort_by);

    // =====================================================
    // CURRENT PAGE
    // =====================================================

    const currentPage =
      parsePage(page);

    // =====================================================
    // GET FILTER OPTIONS
    //
    // This runs independently from the product query.
    // =====================================================

    const filters =
      await getFilters(
        normalizedCollection
      );

    // =====================================================
    // FETCH PRODUCTS
    //
    // IMPORTANT:
    //
    // There is NO full catalog query here.
    //
    // PostgreSQL performs:
    //
    // filter
    // availability
    // sorting
    // count
    // pagination
    //
    // before returning the data.
    // =====================================================

    let products = [];

    let total = 0;

    let productsError = null;

    try {
      const result =
        await fetchProducts({
          collection:
            normalizedCollection,

          minPrice,

          maxPrice,

          vendor,

          product_type,

          color,

          size,

          fabric,

          delivery_timeline,

          page:
            currentPage,

          sort_by:
            normalizedSort
        });

      products =
        result.products;

      total =
        result.total;
    } catch (error) {
      console.error(
        "Product query error:",
        error
      );

      productsError =
        error?.message ||
        "Failed to load products";
    }

    // =====================================================
    // TOTAL PAGES
    // =====================================================

    const totalPages =
      Math.max(
        1,
        Math.ceil(
          total / PAGE_LIMIT
        )
      );

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      filters,

      products,

      pagination: {
        total,

        totalPages,

        currentPage
      },

      ...(productsError
        ? {
            productsError
          }
        : {})
    });
  } catch (error) {
    console.error(
      "API ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Server error"
    });
  }
}