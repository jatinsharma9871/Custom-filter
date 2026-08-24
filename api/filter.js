import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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
      size,
      fabric,
      delivery_timeline,
      page,
      sort_by
    } = req.query;

    const normalizedCollection = String(collection || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "");

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

    const sortAlpha = (values) =>
      values.sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );

    const variantIsAvailable = (variant) =>
      variant &&
      (Number(variant.inventory_quantity) > 0 || variant.available === true);

    /* ================= FETCH PRODUCTS ================= */

  /* ================= FETCH PRODUCTS ================= */

let cachedFilters = null;
console.log("Collection:", normalizedCollection);
if (normalizedCollection && normalizedCollection !== "all") {
  const { data } = await supabase
    .from("filter_cache")
    .select("filters")
    .eq("collection_handle", normalizedCollection)
    .maybeSingle();

  cachedFilters = data?.filters || null;
}

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
  .select(PRODUCT_COLUMNS)
  .eq("status", "ACTIVE")
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

if (minPrice) {
  query = query.gte("price", Number(minPrice));
}

if (maxPrice) {
  query = query.lte("price", Number(maxPrice));
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
const { data: allProducts, error } = await query;
console.log({
  collection: normalizedCollection,
  fetchedProducts: allProducts.length
});
if (error) {
  console.error("Supabase Error:", error);
  return res.status(500).json({ error: error.message });
}

console.log("Supabase products:", allProducts?.length || 0);

if (error) {
  return res.status(500).json({
    error: error.message
  });
}

//    let allProducts = [];
// let from = 0;
// const batchSize = 1000;

// while (true) {
  
//   const { data, error } = await query.range(from, from + batchSize - 1);

//   if (error) {
//     return res.status(500).json({ error: error.message });
//   }

//   if (!data || data.length === 0) {
//     break;
//   }

//   allProducts.push(...data);

//   console.log(
//     `Fetched ${data.length} products (Total: ${allProducts.length})`
//   );

//   if (data.length < batchSize) {
//     break;
//   }

//   from += batchSize;
// }

console.log("Final products fetched:", allProducts.length);

    if (!allProducts?.length) {
  console.log("No products found");
  console.log("Cached colors:", cachedFilters?.colors);

  return res.status(200).json({
    filters: {},
    products: [],
    pagination: {
      total: 0,
      totalPages: 0,
      currentPage: 1
    }
  });
}

    /* ================= APPLY FILTERS ================= */

    let products = [...allProducts];
    console.log("Selected color:", color);
// const { data, error } = await query;
    // Designer
    // if (vendor) {
    //   const selectedVendors = toList(vendor).map(normalize);

    //   products = products.filter((product) =>
    //     selectedVendors.includes(normalize(product.vendor))
    //   );
    // }

    // Product type
    // if (product_type) {
    //   const selectedTypes = toList(product_type).map(normalize);

    //   products = products.filter((product) =>
    //     selectedTypes.includes(normalize(product.product_type))
    //   );
    // }

    // Fabric
    if (color) {
  const selectedColors = toList(color).map(normalize);

  products = products.filter((product) => {
    const productColors = safeParse(product.color)
  .flatMap(item => {
    if (typeof item === "object" && item !== null) {
      return Object.values(item);
    }

    return String(item).split(",");
  })
  .map(item => item.trim())
  .filter(Boolean)
  .forEach(color => colorSet.add(color));


    return selectedColors.some(selected =>
      productColors.includes(selected)
    );
  });

  console.log("After color:", products.length);
}
    if (fabric) {
      const selectedFabrics = toList(fabric).map(normalize);

      products = products.filter((product) => {
        const productFabrics = safeParse(product.fabric).map(normalize);

        return selectedFabrics.some((selectedFabric) =>
          productFabrics.includes(selectedFabric)
        );
      });
    }

  
    if (size) {
      const selectedSizes = toList(size).map(normalize);

      products = products.filter((product) =>
        safeParse(product.variants).some(
          (variant) =>
            selectedSizes.includes(normalize(variant?.size)) &&
            variantIsAvailable(variant)
        )
      );
    }

    // Delivery timeline
    if (delivery_timeline) {
      const selectedDeliveryTimes = toList(delivery_timeline).map(normalize);

      products = products.filter((product) => {
        const productDeliveryTimes = safeParse(
          product.delivery_timeline
        ).map(normalize);

        return selectedDeliveryTimes.some((selectedTime) =>
          productDeliveryTimes.includes(selectedTime)
        );
      });
    }

    // Build filter options after selected filters, before inventory filtering.
    const filterSource = [...allProducts];

    /* ================= INVENTORY FILTER ================= */

    products = products.filter((product) => {
      if (Number(product.inventory_quantity) > 0) return true;

      return safeParse(product.variants).some(variantIsAvailable);
    });

    /* ================= FORMAT PRODUCTS ================= */

    let formattedProducts = products.map((product) => ({
      ...product,
      price: Number(product.price || 0),
      compare_at_price: Number(
        product.compare_at_price ||
          product.compareAtPrice ||
          product.mrp ||
          0
      )
    }));
console.log("Filtered products:", formattedProducts.length);
    /* ================= SORT ================= */


    

    /* ================= PAGINATION ================= */

    const currentPage = Math.max(1, Number(page) || 1);
    const limit = 12;
    const total = formattedProducts.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const paginatedProducts = formattedProducts.slice(
      (currentPage - 1) * limit,
      currentPage * limit
    );

    /* ================= BUILD FILTER OPTIONS ================= */

    const vendorSet = new Set();
    const typeSet = new Set();
    const colorSet = new Set();
    const fabricSet = new Set();
    const deliverySet = new Set();
    const sizeAvailability = {};


    filterSource.forEach((product) => {
      if (product.vendor) {
        vendorSet.add(String(product.vendor).trim());
      }

      if (product.product_type) {
        typeSet.add(String(product.product_type).trim());
      }

      safeParse(product.color)
  .flatMap(item => String(item).split(","))
  .map(item => item.trim())
  .filter(Boolean)
  .forEach(color => colorSet.add(color));
console.log({
  colors: [...colorSet],
  vendors: [...vendorSet],
  productTypes: [...typeSet]
});
      safeParse(product.fabric).forEach((item) => {
        if (item) fabricSet.add(String(item).trim());
      });

      safeParse(product.delivery_timeline).forEach((item) => {
        if (item) deliverySet.add(String(item).trim());
      });

      safeParse(product.variants).forEach((variant) => {
        const variantSize = String(variant?.size || "").trim();

        if (!variantSize) return;

        if (!(variantSize in sizeAvailability)) {
          sizeAvailability[variantSize] = false;
        }

        if (variantIsAvailable(variant)) {
          sizeAvailability[variantSize] = true;
        }
      });
    });

   const vendors =
  cachedFilters?.vendors?.map(v => v.name ?? v) ??
  [...vendorSet];

const productTypes =
  cachedFilters?.productTypes?.map(v => v.name ?? v) ??
  [...typeSet];

  const normalizeCached = arr =>
  (arr || []).map(v =>
    typeof v === "object"
      ? v.name
      : v
  );
  
  const colors =
    cachedFilters
        ? normalizeCached(cachedFilters.colors)
        : [...colorSet];


  
console.log({
  cachedColors: cachedFilters?.colors,
  generatedColors: [...colorSet]
});
const fabrics =
  cachedFilters?.fabrics ??
  [...fabricSet];

const delivery =
  cachedFilters?.delivery_timeline ??
  [...deliverySet];

const sizes = cachedFilters?.sizes ?? Object.keys(sizeAvailability);

    const productPrices = formattedProducts.map((product) => product.price);
console.log(JSON.stringify(cachedFilters, null, 2));
console.log({
  total,
  totalPages,
  currentPage
});
console.log("Cached filters exists:", !!cachedFilters);

if (cachedFilters) {
  console.log("Cached colors:", cachedFilters.colors?.length);
  console.log("Cached sizes:", cachedFilters.sizes?.length);
  console.log("Cached vendors:", cachedFilters.vendors?.length);
  console.log("Cached productTypes:", cachedFilters.productTypes?.length);
  console.log("Cached fabrics:", cachedFilters.fabrics?.length);
}
    return res.status(200).json({
     filters: {
  vendors:
    vendors.length
      ? sortAlpha(vendors).map(name => ({ name }))
      : [],

  productTypes:
    productTypes.length
      ? sortAlpha(productTypes).map(name => ({ name }))
      : [],

 colors:
  colors.length
    ? sortAlpha(colors).map(name => ({ name }))
    : [],

  fabrics: fabrics.length ? sortAlpha(fabrics) : [],

  delivery_timeline:
    delivery.length ? sortAlpha(delivery) : [],

  sizes:
  Array.isArray(sizes)
    ? sizes.map(item => {
        if (typeof item === "object") return item;

        return {
          name: item,
          available: sizeAvailability[item]
        };
      })
    : [],
  priceRange: {
    min: productPrices.length ? Math.min(...productPrices) : 0,
    max: productPrices.length ? Math.max(...productPrices) : 0
  }
},
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