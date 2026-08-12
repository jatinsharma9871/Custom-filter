import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRODUCT_COLUMNS = `
  id,
  title,
  handle,
  vendor,
  product_type,
  price,
  image,
  color,
  size,
  fabric,
  delivery_time
`;

function getFirstQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function getQueryValues(value) {
  if (value === undefined || value === null) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueSorted(values) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map((value) => String(value).trim())
        .filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function parseNumber(value, fieldName) {
  const parsed = Number.parseFloat(
    getFirstQueryValue(value)
  );

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return parsed;
}

function normalizeCollection(value) {
  return String(value)
    .trim()
    .replace(/-/g, " ");
}

function applyMultiValueFilter(query, column, value) {
  const values = getQueryValues(value);

  if (values.length === 1) {
    return query.eq(column, values[0]);
  }

  if (values.length > 1) {
    return query.in(column, values);
  }

  return query;
}

export default async function handler(req, res) {
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

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const {
      collection,
      minPrice,
      maxPrice,
      vendor,
      color,
      size,
    } = req.query;

    if (!collection) {
      return res.status(400).json({
        error: "Collection required",
      });
    }

    const normalizedCollection =
      normalizeCollection(collection);

    /*
      Fetch the collection products used to build
      the filter labels and price range.
    */
    const {
      data: allProducts,
      error: metadataError,
    } = await supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .ilike(
        "product_type",
        normalizedCollection
      )
      .order("title", {
        ascending: true,
      });

    if (metadataError) {
      throw metadataError;
    }

    if (!allProducts || allProducts.length === 0) {
      return res.status(200).json({
        filters: {
          vendors: [],
          colors: [],
          sizes: [],
          priceRange: {
            min: 0,
            max: 0,
          },
        },
        products: [],
      });
    }

    /*
      Build filter labels.
    */
    const vendors = uniqueSorted(
      allProducts.map((product) => product.vendor)
    );

    const colors = uniqueSorted(
      allProducts.map((product) => product.color)
    );

    const sizes = uniqueSorted(
      allProducts.map((product) => product.size)
    );

    const prices = allProducts
      .map((product) => Number.parseFloat(product.price))
      .filter((price) => Number.isFinite(price));

    const min = prices.length
      ? Math.min(...prices)
      : 0;

    const max = prices.length
      ? Math.max(...prices)
      : 0;

    /*
      Build the filtered product query.
    */
    let query = supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .ilike(
        "product_type",
        normalizedCollection
      )
      .order("title", {
        ascending: true,
      });

    /*
      Price filters.
    */
    if (minPrice !== undefined) {
      const minP = parseNumber(
        minPrice,
        "minPrice"
      );

      query = query.gte("price", minP);
    }

    if (maxPrice !== undefined) {
      const maxP = parseNumber(
        maxPrice,
        "maxPrice"
      );

      query = query.lte("price", maxP);
    }

    /*
      Multiple filter values are supported:

      ?vendor=Brand A&vendor=Brand B
      ?color=Red&color=Blue
      ?size=S&size=M
    */
    query = applyMultiValueFilter(
      query,
      "vendor",
      vendor
    );

    query = applyMultiValueFilter(
      query,
      "color",
      color
    );

    query = applyMultiValueFilter(
      query,
      "size",
      size
    );

    const {
      data: filteredProducts,
      error: productsError,
    } = await query;

    if (productsError) {
      throw productsError;
    }

    return res.status(200).json({
      filters: {
        vendors,
        colors,
        sizes,
        priceRange: {
          min,
          max,
        },
      },
      products: filteredProducts || [],
    });
  } catch (error) {
    console.error("Products API error:", error);

    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
}