import { createClient } from "@supabase/supabase-js";
const METADATA_CACHE = new Map();
const CACHE_TIME = 10 * 60 * 1000; // 10 minutes
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRODUCT_COLUMNS = `
  id,
  title,
  handle,
  vendor,
  price,
  compare_at_price,
  image,
  images,
  product_type,
  color,
  size,
  fabric,
  delivery_time
`;

const PAGE_SIZE = 24;

function first(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function values(value) {
  if (value === undefined || value === null) return [];

  return (Array.isArray(value) ? value : [value])
    .flatMap(v => String(v).split(","))
    .map(v => v.trim())
    .filter(Boolean);
}

function unique(values) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map(v => String(v).trim())
    )
  ].sort((a, b) => a.localeCompare(b));
}

function numberValue(value, fallback = null) {
  if (value === undefined || value === null || value === "")
    return fallback;

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function normalizeCollection(handle) {

  if (!handle || handle === "all")
    return null;

  return String(handle)
    .replace(/-/g, " ")
    .trim();
}

function applyMultiFilter(query, column, value) {

  const list = values(value);

  if (!list.length)
    return query;

  if (list.length === 1)
return query.eq(column, list[0]);

  return query.in(column, list);
}export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
const start = Date.now();
    const {
      collection,
      page,
      sort_by,

      vendor,
      color,
      size,
      fabric,
      product_type,
      delivery_timeline,

      minPrice,
      maxPrice,

    } = req.query;

    const currentPage =
      Math.max(numberValue(page, 1), 1);

    const from =
      (currentPage - 1) * PAGE_SIZE;

    const to =
      from + PAGE_SIZE - 1;

    const collectionName =
      normalizeCollection(collection);

    /* ======================================
       BASE QUERY
    ====================================== */

let baseQuery = supabase
  .from("products")
  .select(`
    vendor,
    color,
    size,
    fabric,
    delivery_time,
    product_type,
    price
  `);

    if (collectionName) {
      baseQuery = baseQuery.ilike(
        "product_type",
        collectionName
      );
    }
    /* ======================================
   LOAD FILTER METADATA
====================================== */

let metaRows;

const cacheKey = collectionName || "all";

const cached = METADATA_CACHE.get(cacheKey);

if (
  cached &&
  Date.now() - cached.time < CACHE_TIME
) {
  metaRows = cached.data;
} else {
  const { data, error } = await baseQuery;

  if (error) throw error;

  metaRows = data || [];

  METADATA_CACHE.set(cacheKey, {
    time: Date.now(),
    data: metaRows
  });
}

const vendors = new Set();
const colors = new Set();
const sizes = new Set();
const fabrics = new Set();
const productTypes = new Set();
const deliveryTimeline = new Set();

let lowestPrice = Number.MAX_SAFE_INTEGER;
let highestPrice = 0;
if (price < lowestPrice)
    lowestPrice = price;

if (price > highestPrice)
    highestPrice = price;const priceRange = {
    min:
        lowestPrice === Number.MAX_SAFE_INTEGER
            ? 0
            : lowestPrice,

    max: highestPrice
};

for (const p of metaRows || []) {

  if (p.vendor)
    vendors.add(p.vendor);

  if (p.color)
    colors.add(p.color);

  if (p.size)
    sizes.add(p.size);

  if (p.fabric)
    fabrics.add(p.fabric);

  if (p.product_type)
    productTypes.add(p.product_type);

  if (p.delivery_time)
    deliveryTimeline.add(p.delivery_time);

  const price = Number(p.price);

  if (!Number.isFinite(price))
    continue;

  if (price < minPrice)
    minPrice = price;

  if (price > maxPrice)
    maxPrice = price;
}

const priceRange = {
  min:
    minPrice === Number.MAX_SAFE_INTEGER
      ? 0
      : minPrice,

  max: maxPrice,
};
    
    
    /* ======================================
       PRODUCT QUERY
    ====================================== */
console.log({
  collection: collectionName,
  page: currentPage,
  sort: sort_by,
  vendor,
  color,
  size,
  fabric,
  delivery_timeline,
  minPrice,
  maxPrice
});
    let query = supabase
      .from("products")
      .select(PRODUCT_COLUMNS, {
        count: "exact",
      });

    if (collectionName) {
      query = query.ilike(
        "product_type",
        collectionName
      );
    }

    query = applyMultiFilter(
      query,
      "vendor",
      vendor
    );

    query = applyMultiFilter(
      query,
      "color",
      color
    );

    query = applyMultiFilter(
      query,
      "size",
      size
    );

    query = applyMultiFilter(
      query,
      "fabric",
      fabric
    );

    query = applyMultiFilter(
      query,
      "product_type",
      product_type
    );

    query = applyMultiFilter(
      query,
      "delivery_time",
      delivery_timeline
    );

    if (minPrice !== undefined) {
      query = query.gte(
        "price",
        Number(minPrice)
      );
    }

    if (maxPrice !== undefined) {
      query = query.lte(
        "price",
        Number(maxPrice)
      );
    }    /* ======================================
       SORTING
    ====================================== */

    switch (sort_by) {

  case "price-ascending":
    query = query.order("price");
    break;

  case "price-descending":
    query = query.order("price", {
      ascending: false
    });
    break;

  case "title-ascending":
    query = query.order("title");
    break;

  case "title-descending":
    query = query.order("title", {
      ascending: false
    });
    break;

  case "created-ascending":
    query = query.order("id");
    break;

  case "created-descending":
    query = query.order("id", {
      ascending: false
    });
    break;

  default:
    query = query.order("title");
}

    /* ======================================
       PAGINATION
    ====================================== */

    query = query.range(from, to);





const {
  data: products,
  error: productError,
  count,
} = productResult;


if (productError) {
  throw productError;
}

    const totalProducts = count || 0;

    const totalPages =
      Math.max(
        1,
        Math.ceil(totalProducts / PAGE_SIZE)
      );

    /* ======================================
       RESPONSE
    ====================================== */
console.log(
  `Filter API: ${Date.now() - start} ms`
);
    return res.status(200).json({

      filters: {

  vendors: [...vendors].sort(),

  colors: [...colors].sort(),

  sizes: [...sizes].sort(),

  fabrics: [...fabrics].sort(),

  productTypes: [...productTypes].sort(),

  delivery_timeline: [...deliveryTimeline].sort(),

  priceRange,

},
      products: products || [],

      pagination: {

        currentPage,

        totalPages,

        totalProducts,

        pageSize: PAGE_SIZE,

      },

    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({

      error: error.message,

    });

  }

}
