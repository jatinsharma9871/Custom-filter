import { createClient } from "@supabase/supabase-js";

/* =========================================================
   SUPABASE
========================================================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE
);

/* =========================================================
   HELPERS
========================================================= */

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const normalizeComparable = (value) =>
  normalize(value).replace(/[\s_-]+/g, "");

const cleanValue = (value) => {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
};

const safeParse = (value) => {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "object") {
    return [value];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);

      return Array.isArray(parsed)
        ? parsed
        : [parsed];
    } catch {
      /*
       * Do NOT blindly split all strings by comma.
       * Some metafield values may legitimately contain commas.
       */

      return [
        trimmed
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .replace(/^"/, "")
          .replace(/"$/, "")
          .trim()
      ].filter(Boolean);
    }
  }

  return [value];
};

const toList = (value) => {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((item) => String(item).split(","))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const sortAlpha = (values) =>
  [...values].sort((a, b) =>
    String(a).localeCompare(
      String(b),
      undefined,
      {
        sensitivity: "base",
        numeric: true
      }
    )
  );

/* =========================================================
   UNIQUE VALUES
========================================================= */

const uniqueValues = (values) => {
  const output = [];
  const seen = new Set();

  for (const value of values) {
    const cleaned = cleanValue(value);

    if (!cleaned) {
      continue;
    }

    const key = normalize(cleaned);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(cleaned);
  }

  return output;
};

/* =========================================================
   COLOR
========================================================= */

const standardizeColor = (value) => {
  const label = cleanValue(value);

  if (!label) {
    return null;
  }

  const comparable =
    normalizeComparable(label);

  if (
    [
      "multi",
      "multicolor",
      "multicolour"
    ].includes(comparable)
  ) {
    return "Multicolour";
  }

  return label;
};

const colorMatches = (
  productColor,
  selectedColor
) =>
  normalizeComparable(productColor) ===
  normalizeComparable(selectedColor);

/* =========================================================
   VARIANTS
========================================================= */

const getVariants = (product) =>
  safeParse(product?.variants).filter(
    (variant) =>
      variant &&
      typeof variant === "object" &&
      !Array.isArray(variant)
  );

const variantIsAvailable = (variant) => {
  /*
   * Main value written by sync.js
   */

  if (
    variant?.inventory_quantity !== undefined &&
    variant?.inventory_quantity !== null
  ) {
    return (
      Number(
        variant.inventory_quantity || 0
      ) > 0
    );
  }

  /*
   * Fallback if available was saved.
   */

  if (variant?.available !== undefined) {
    return (
      variant.available === true ||
      variant.available === "true" ||
      variant.available === 1 ||
      variant.available === "1"
    );
  }

  return false;
};

const productIsInStock = (product) => {
  const variants =
    getVariants(product);

  if (variants.length) {
    return variants.some(
      variantIsAvailable
    );
  }

  return (
    Number(
      product?.inventory_quantity || 0
    ) > 0
  );
};

/* =========================================================
   GET VARIANT OPTION

   Supports:

   {
     size: "M",
     color: "Red"
   }

   {
     options: {
       Size: "M",
       Color: "Red"
     }
   }

   {
     selectedOptions: [
       { name: "Size", value: "M" }
     ]
   }

   {
     selected_options: [...]
   }
========================================================= */

const getVariantOption = (
  variant,
  names
) => {
  if (!variant) {
    return null;
  }

  const accepted =
    names.map(normalize);

  /* DIRECT PROPERTIES */

  for (const name of names) {
    const value =
      variant[name];

    if (
      value !== undefined &&
      value !== null &&
      cleanValue(value)
    ) {
      return cleanValue(value);
    }
  }

  /*
   * Case-insensitive direct properties.
   */

  for (const [key, value] of Object.entries(variant)) {
    if (
      accepted.includes(normalize(key)) &&
      value !== undefined &&
      value !== null &&
      cleanValue(value)
    ) {
      return cleanValue(value);
    }
  }

  /* OPTIONS OBJECT */

  if (
    variant.options &&
    typeof variant.options === "object" &&
    !Array.isArray(variant.options)
  ) {
    for (
      const [key, value]
      of Object.entries(variant.options)
    ) {
      if (
        accepted.includes(normalize(key)) &&
        cleanValue(value)
      ) {
        return cleanValue(value);
      }
    }
  }

  /* OPTIONS ARRAY */

  if (Array.isArray(variant.options)) {
    for (const option of variant.options) {
      if (
        option &&
        typeof option === "object" &&
        accepted.includes(
          normalize(
            option.name ||
              option.key
          )
        )
      ) {
        const value =
          cleanValue(
            option.value
          );

        if (value) {
          return value;
        }
      }
    }
  }

  /* SELECTED OPTIONS */

  const selectedOptions = safeParse(
    variant.selectedOptions ||
      variant.selected_options
  );

  for (const option of selectedOptions) {
    if (
      !option ||
      typeof option !== "object"
    ) {
      continue;
    }

    const optionName =
      normalize(
        option.name ||
          option.key
      );

    if (
      accepted.includes(optionName)
    ) {
      const value =
        cleanValue(option.value);

      if (value) {
        return value;
      }
    }
  }

  return null;
};

/* =========================================================
   GET ALL PRODUCT COLORS

   IMPORTANT:

   This combines ALL possible color sources:

   1. products.color
   2. variants[].color
   3. variants[].colour
   4. variants[].options
   5. variants[].selectedOptions
   6. variants[].selected_options
========================================================= */

const getProductColors = (product) => {
  const colors = [];

  /* PRODUCT COLOR COLUMN */

  safeParse(product?.color).forEach(
    (value) => {
      if (
        typeof value === "string" ||
        typeof value === "number"
      ) {
        const color =
          standardizeColor(value);

        if (color) {
          colors.push(color);
        }
      }
    }
  );

  /* VARIANT COLORS */

  const variants =
    getVariants(product);

  variants.forEach((variant) => {
    const color =
      getVariantOption(
        variant,
        [
          "color",
          "colour"
        ]
      );

    const standardized =
      standardizeColor(color);

    if (standardized) {
      colors.push(standardized);
    }
  });

  return uniqueValues(colors);
};

/* =========================================================
   GET PRODUCT FABRICS
========================================================= */

const getProductFabrics = (product) =>
  uniqueValues(
    safeParse(product?.fabric)
      .map((value) => {
        if (
          typeof value === "string" ||
          typeof value === "number"
        ) {
          return cleanValue(value);
        }

        return "";
      })
      .filter(Boolean)
  );

/* =========================================================
   GET DELIVERY VALUES
========================================================= */

const getDeliveryValues = (product) =>
  uniqueValues(
    safeParse(
      product?.delivery_timeline
    )
      .map((value) => {
        if (
          typeof value === "string" ||
          typeof value === "number"
        ) {
          return cleanValue(value);
        }

        return "";
      })
      .filter(Boolean)
  );

/* =========================================================
   HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {
  /* ================= CORS ================= */

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

  if (req.method === "OPTIONS") {
    return res
      .status(200)
      .end();
  }

  if (req.method !== "GET") {
    return res
      .status(405)
      .json({
        error: "Method not allowed"
      });
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

    /* =====================================================
       COLLECTION
    ===================================================== */

    const normalizedCollection =
      String(collection || "")
        .trim()
        .toLowerCase()
        .replace(
          /[^a-z0-9-_]/g,
          ""
        );

    /* =====================================================
       FETCH PRODUCTS
    ===================================================== */

    let query =
      supabase
        .from("products")
        .select("*")
        .eq(
          "status",
          "ACTIVE"
        )
        .eq(
          "published",
          true
        );

    if (
      normalizedCollection &&
      normalizedCollection !== "all"
    ) {
      query =
        query.filter(
          "collection_handle",
          "cs",
          `["${normalizedCollection}"]`
        );
    }

    const {
      data: allProducts,
      error
    } = await query;

    if (error) {
      console.error(
        "SUPABASE ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          error: error.message
        });
    }

    if (!allProducts?.length) {
      return res
        .status(200)
        .json({
          filters: {
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
          },

          products: [],

          pagination: {
            total: 0,
            totalPages: 0,
            currentPage: 1
          }
        });
    }

    /* =====================================================
       REMOVE OUT-OF-STOCK PRODUCTS FIRST
    ===================================================== */

    let products =
      allProducts.filter(
        productIsInStock
      );

    /* =====================================================
       VENDOR
    ===================================================== */

    if (vendor) {
      const selected =
        toList(vendor)
          .map(normalize);

      products =
        products.filter(
          (product) =>
            selected.includes(
              normalize(
                product.vendor
              )
            )
        );
    }

    /* =====================================================
       PRODUCT TYPE
    ===================================================== */

    if (product_type) {
      const selected =
        toList(product_type)
          .map(normalize);

      products =
        products.filter(
          (product) =>
            selected.includes(
              normalize(
                product.product_type
              )
            )
        );
    }

    /* =====================================================
       FABRIC
    ===================================================== */

    if (fabric) {
      const selected =
        toList(fabric)
          .map(normalize);

      products =
        products.filter(
          (product) => {
            const values =
              getProductFabrics(
                product
              ).map(normalize);

            return selected.some(
              (item) =>
                values.includes(item)
            );
          }
        );
    }

    /* =====================================================
       PRICE
    ===================================================== */

    const parsedMinPrice =
      minPrice !== undefined &&
      minPrice !== ""
        ? Number(minPrice)
        : null;

    const parsedMaxPrice =
      maxPrice !== undefined &&
      maxPrice !== ""
        ? Number(maxPrice)
        : null;

    if (
      parsedMinPrice !== null ||
      parsedMaxPrice !== null
    ) {
      products =
        products.filter(
          (product) => {
            const price =
              Number(
                product.price || 0
              );

            if (
              parsedMinPrice !== null &&
              Number.isFinite(
                parsedMinPrice
              ) &&
              price < parsedMinPrice
            ) {
              return false;
            }

            if (
              parsedMaxPrice !== null &&
              Number.isFinite(
                parsedMaxPrice
              ) &&
              price > parsedMaxPrice
            ) {
              return false;
            }

            return true;
          }
        );
    }

    /* =====================================================
       COLOR
    ===================================================== */

    if (color) {
      const selectedColors =
        toList(color)
          .map(standardizeColor)
          .filter(Boolean);

      products =
        products.filter(
          (product) => {
            const productColors =
              getProductColors(
                product
              );

            return (
              selectedColors.some(
                (selectedColor) =>
                  productColors.some(
                    (productColor) =>
                      colorMatches(
                        productColor,
                        selectedColor
                      )
                  )
              )
            );
          }
        );
    }

    /* =====================================================
       SIZE

       Only show product if requested size has inventory.
    ===================================================== */

    if (size) {
      const selectedSizes =
        toList(size)
          .map(normalize);

      products =
        products.filter(
          (product) => {
            const variants =
              getVariants(product);

            return variants.some(
              (variant) => {
                if (
                  !variantIsAvailable(
                    variant
                  )
                ) {
                  return false;
                }

                const variantSize =
                  getVariantOption(
                    variant,
                    ["size"]
                  );

                return (
                  variantSize &&
                  selectedSizes.includes(
                    normalize(
                      variantSize
                    )
                  )
                );
              }
            );
          }
        );
    }

    /* =====================================================
       DELIVERY TIMELINE
    ===================================================== */

    if (delivery_timeline) {
      const selected =
        toList(
          delivery_timeline
        ).map(normalize);

      products =
        products.filter(
          (product) => {
            const values =
              getDeliveryValues(
                product
              ).map(normalize);

            return selected.some(
              (item) =>
                values.includes(item)
            );
          }
        );
    }

    /* =====================================================
       FILTER SOURCE
    ===================================================== */

    const filterSource =
      [...products];

    /* =====================================================
       FORMAT PRODUCTS
    ===================================================== */

    let formattedProducts =
      products.map(
        (product) => ({
          ...product,

          price:
            Number(
              product.price || 0
            ),

          compare_at_price:
            Number(
              product.compare_at_price ||
                product.compareAtPrice ||
                product.mrp ||
                0
            ),

          /*
           * Return all combined colors.
           */

          color:
            getProductColors(
              product
            )
        })
      );

    /* =====================================================
       SORT
    ===================================================== */

    const sortMap = {
      manual:
        (a, b) =>
          Number(
            a.position ?? 9999
          ) -
          Number(
            b.position ?? 9999
          ),

      "price-ascending":
        (a, b) =>
          a.price - b.price,

      "price-descending":
        (a, b) =>
          b.price - a.price,

      "title-ascending":
        (a, b) =>
          String(
            a.title || ""
          ).localeCompare(
            String(
              b.title || ""
            ),
            undefined,
            {
              sensitivity: "base"
            }
          ),

      "title-descending":
        (a, b) =>
          String(
            b.title || ""
          ).localeCompare(
            String(
              a.title || ""
            ),
            undefined,
            {
              sensitivity: "base"
            }
          ),

      "created-descending":
        (a, b) =>
          new Date(
            b.created_at || 0
          ) -
          new Date(
            a.created_at || 0
          ),

      "created-ascending":
        (a, b) =>
          new Date(
            a.created_at || 0
          ) -
          new Date(
            b.created_at || 0
          ),

      "best-selling":
        (a, b) =>
          Number(
            a.best_selling_rank ??
              999999
          ) -
          Number(
            b.best_selling_rank ??
              999999
          )
    };

    if (!sort_by) {
      formattedProducts.sort(
        sortMap[
          "created-descending"
        ]
      );
    } else {
      formattedProducts.sort(
        sortMap[sort_by] ||
          (() => 0)
      );
    }

    /* =====================================================
       PAGINATION
    ===================================================== */

    const currentPage =
      Math.max(
        1,
        Number(page) || 1
      );

    const limit = 12;

    const total =
      formattedProducts.length;

    const totalPages =
      total
        ? Math.ceil(
            total / limit
          )
        : 0;

    const start =
      (currentPage - 1) *
      limit;

    const paginatedProducts =
      formattedProducts.slice(
        start,
        start + limit
      );

    /* =====================================================
       BUILD FILTER OPTIONS
    ===================================================== */

    const vendorValues = [];
    const typeValues = [];
    const colorValues = [];
    const fabricValues = [];
    const deliveryValues = [];

    /*
     * Map normalized size => original name + availability.
     */

    const sizeAvailability =
      new Map();

    for (
      const product
      of filterSource
    ) {
      /* VENDOR */

      if (product.vendor) {
        vendorValues.push(
          cleanValue(
            product.vendor
          )
        );
      }

      /* PRODUCT TYPE */

      if (
        product.product_type
      ) {
        typeValues.push(
          cleanValue(
            product.product_type
          )
        );
      }

      /* COLORS */

      const productColors =
        getProductColors(
          product
        );

      colorValues.push(
        ...productColors
      );

      /* FABRICS */

      fabricValues.push(
        ...getProductFabrics(
          product
        )
      );

      /* DELIVERY */

      deliveryValues.push(
        ...getDeliveryValues(
          product
        )
      );

      /* SIZES */

      const variants =
        getVariants(product);

      for (
        const variant
        of variants
      ) {
        const variantSize =
          getVariantOption(
            variant,
            ["size"]
          );

        if (!variantSize) {
          continue;
        }

        const key =
          normalize(
            variantSize
          );

        if (
          !sizeAvailability.has(
            key
          )
        ) {
          sizeAvailability.set(
            key,
            {
              name:
                cleanValue(
                  variantSize
                ),

              available:
                false
            }
          );
        }

        if (
          variantIsAvailable(
            variant
          )
        ) {
          sizeAvailability.get(
            key
          ).available =
            true;
        }
      }
    }

    /* =====================================================
       FINAL FILTER VALUES
    ===================================================== */

    const vendors =
      sortAlpha(
        uniqueValues(
          vendorValues
        )
      );

    const productTypes =
      sortAlpha(
        uniqueValues(
          typeValues
        )
      );

    const colors =
      sortAlpha(
        uniqueValues(
          colorValues
            .map(
              standardizeColor
            )
            .filter(Boolean)
        )
      );

    const fabrics =
      sortAlpha(
        uniqueValues(
          fabricValues
        )
      );

    const delivery =
      sortAlpha(
        uniqueValues(
          deliveryValues
        )
      );

    const sizes =
      [...sizeAvailability.values()]
        .sort(
          (a, b) =>
            String(
              a.name
            ).localeCompare(
              String(
                b.name
              ),
              undefined,
              {
                sensitivity: "base",
                numeric: true
              }
            )
        );

    /* =====================================================
       PRICE RANGE
    ===================================================== */

    const prices =
      formattedProducts
        .map(
          (product) =>
            Number(
              product.price
            )
        )
        .filter(
          (price) =>
            Number.isFinite(
              price
            )
        );

    /* =====================================================
       RESPONSE
    ===================================================== */

    return res
      .status(200)
      .json({
        filters: {
          vendors:
            vendors.length > 1
              ? vendors.map(
                  (name) => ({
                    name
                  })
                )
              : [],

          productTypes:
            productTypes.length > 1
              ? productTypes.map(
                  (name) => ({
                    name
                  })
                )
              : [],

          colors:
            colors.length > 1
              ? colors.map(
                  (name) => ({
                    name
                  })
                )
              : [],

          fabrics:
            fabrics.length > 1
              ? fabrics
              : [],

          delivery_timeline:
            delivery.length > 1
              ? delivery
              : [],

          sizes:
            sizes.length > 1
              ? sizes
              : [],

          priceRange: {
            min:
              prices.length
                ? Math.min(
                    ...prices
                  )
                : 0,

            max:
              prices.length
                ? Math.max(
                    ...prices
                  )
                : 0
          }
        },

        products:
          paginatedProducts,

        pagination: {
          total,
          totalPages,
          currentPage
        }
      });

  } catch (error) {
    console.error(
      "API ERROR:",
      error
    );

    return res
      .status(500)
      .json({
        error:
          error.message ||
          "Server error"
      });
  }
}