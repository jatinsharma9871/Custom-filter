import { createClient } from "@supabase/supabase-js";

/* =========================================================
   SUPABASE
========================================================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);


/* =========================================================
   HELPERS
========================================================= */

function safeParse(value) {
  try {
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
        const parsed =
          JSON.parse(trimmed);

        return Array.isArray(parsed)
          ? parsed
          : [parsed];
      } catch {
        /*
         * Support comma-separated strings too.
         */

        if (trimmed.includes(",")) {
          return trimmed
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        }

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

  } catch {
    return [];
  }
}


function normalize(value) {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase();
}


function normalizeComparable(value) {
  return normalize(value)
    .replace(/[\s_-]+/g, "");
}


function toList(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((item) =>
        String(item).split(",")
      )
      .map((item) =>
        String(item).trim()
      )
      .filter(Boolean);
  }

  return String(value)
    .split(",")
    .map((item) =>
      item.trim()
    )
    .filter(Boolean);
}


function sortAlpha(values) {
  return [...values].sort(
    (a, b) =>
      String(a).localeCompare(
        String(b),
        undefined,
        {
          sensitivity: "base",
          numeric: true
        }
      )
  );
}


/* =========================================================
   UNIQUE VALUES

   Case-insensitive deduplication.
========================================================= */

function uniqueValues(values) {
  const result = [];

  const seen =
    new Set();

  for (const value of values) {
    const clean =
      String(
        value || ""
      ).trim();

    if (!clean) {
      continue;
    }

    const key =
      normalize(clean);

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(clean);
  }

  return result;
}


/* =========================================================
   STANDARDIZE COLOR
========================================================= */

function standardizeColor(value) {
  const label =
    String(
      value || ""
    ).trim();

  if (!label) {
    return null;
  }

  const comparable =
    normalizeComparable(
      label
    );

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
}


/* =========================================================
   VARIANTS
========================================================= */

function getVariants(product) {
  return safeParse(
    product?.variants
  ).filter(
    (variant) =>
      variant &&
      typeof variant ===
        "object"
  );
}


function variantIsAvailable(
  variant
) {
  /*
   * Prefer inventory quantity.
   */

  if (
    variant
      ?.inventory_quantity !==
      undefined &&
    variant
      ?.inventory_quantity !==
      null
  ) {
    return (
      Number(
        variant
          .inventory_quantity ||
        0
      ) > 0
    );
  }

  /*
   * Fallback to available boolean.
   */

  return (
    variant?.available ===
      true ||
    variant?.available ===
      "true"
  );
}


function productIsInStock(
  product
) {
  const variants =
    getVariants(product);

  if (
    variants.length
  ) {
    return variants.some(
      variantIsAvailable
    );
  }

  return (
    Number(
      product
        ?.inventory_quantity ||
      0
    ) > 0
  );
}


/* =========================================================
   GET VARIANT OPTION

   Supports:

   variant.size
   variant.color

   AND new sync format:

   variant.options

   AND:

   variant.selected_options
========================================================= */

function getVariantOption(
  variant,
  names
) {
  const accepted =
    names.map(
      normalize
    );


  /* ---------------------------------------------------------
     DIRECT PROPERTY
  --------------------------------------------------------- */

  for (
    const name
    of names
  ) {
    const direct =
      variant?.[
        name
      ];

    if (
      direct !==
        undefined &&
      direct !==
        null &&
      String(
        direct
      ).trim()
    ) {
      return String(
        direct
      ).trim();
    }
  }


  /* ---------------------------------------------------------
     OPTIONS OBJECT
  --------------------------------------------------------- */

  if (
    variant?.options &&
    typeof variant.options ===
      "object" &&
    !Array.isArray(
      variant.options
    )
  ) {
    for (
      const [
        key,
        value
      ]
      of Object.entries(
        variant.options
      )
    ) {
      if (
        accepted.includes(
          normalize(key)
        ) &&
        value !==
          undefined &&
        value !==
          null &&
        String(
          value
        ).trim()
      ) {
        return String(
          value
        ).trim();
      }
    }
  }


  /* ---------------------------------------------------------
     SELECTED OPTIONS
  --------------------------------------------------------- */

  const selectedOptions =
    safeParse(
      variant
        ?.selected_options ||
      variant
        ?.selectedOptions
    );

  for (
    const option
    of selectedOptions
  ) {
    if (
      !option ||
      typeof option !==
        "object"
    ) {
      continue;
    }

    if (
      accepted.includes(
        normalize(
          option.name
        )
      )
    ) {
      const value =
        String(
          option.value ||
          ""
        ).trim();

      if (value) {
        return value;
      }
    }
  }

  return null;
}


/* =========================================================
   GET PRODUCT COLORS

   IMPORTANT:

   Combines:
   1. product.color
   2. variant.color
   3. variant.options.Color
   4. variant.selected_options

   This makes sure filter API sees every color synced.
========================================================= */

function getProductColors(
  product,
  {
    availableOnly = false
  } = {}
) {
  const colors = [];


  /* ---------------------------------------------------------
     PRODUCT COLOR ARRAY
  --------------------------------------------------------- */

  safeParse(
    product?.color
  ).forEach(
    (color) => {

      /*
       * Protect against accidentally receiving objects.
       */

      if (
        typeof color ===
          "string" ||
        typeof color ===
          "number"
      ) {
        const clean =
          standardizeColor(
            color
          );

        if (clean) {
          colors.push(clean);
        }
      }
    }
  );


  /* ---------------------------------------------------------
     VARIANT COLORS
  --------------------------------------------------------- */

  const variants =
    getVariants(product);

  for (
    const variant
    of variants
  ) {
    if (
      availableOnly &&
      !variantIsAvailable(
        variant
      )
    ) {
      continue;
    }

    const color =
      getVariantOption(
        variant,
        [
          "color",
          "colour"
        ]
      );

    const clean =
      standardizeColor(
        color
      );

    if (clean) {
      colors.push(clean);
    }
  }


  return uniqueValues(
    colors
  );
}


/* =========================================================
   GET PRODUCT SIZES
========================================================= */

function getProductSizes(
  product,
  {
    availableOnly = false
  } = {}
) {
  const sizes = [];

  const variants =
    getVariants(product);

  for (
    const variant
    of variants
  ) {
    if (
      availableOnly &&
      !variantIsAvailable(
        variant
      )
    ) {
      continue;
    }

    const size =
      getVariantOption(
        variant,
        ["size"]
      );

    if (size) {
      sizes.push(size);
    }
  }

  return uniqueValues(
    sizes
  );
}


/* =========================================================
   VALUE MATCHING
========================================================= */

function exactMatch(
  value,
  selected
) {
  return (
    normalize(value) ===
    normalize(selected)
  );
}


function colorMatch(
  value,
  selected
) {
  /*
   * Use exact normalized matching first.

   * Also normalize spaces/hyphens/underscores so:
   *
   * Dark Blue
   * Dark-Blue
   * dark_blue
   *
   * can match.
   */

  return (
    normalizeComparable(
      value
    ) ===
    normalizeComparable(
      selected
    )
  );
}


/* =========================================================
   API HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {

  /* ---------------------------------------------------------
     CORS
  --------------------------------------------------------- */

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

  if (
    req.method ===
    "OPTIONS"
  ) {
    return res
      .status(200)
      .end();
  }


  if (
    req.method !==
    "GET"
  ) {
    return res
      .status(405)
      .json({
        error:
          "Method not allowed"
      });
  }


  try {

    /* =======================================================
       QUERY PARAMETERS
    ======================================================= */

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
    } =
      req.query;


    const normalizedCollection =
      String(
        collection ||
        ""
      )
        .trim()
        .toLowerCase()
        .replace(
          /[^a-z0-9-_]/g,
          ""
        );


    /* =======================================================
       FETCH PRODUCTS
    ======================================================= */

    let query =
      supabase
        .from(
          "products"
        )
        .select("*")
        .eq(
          "status",
          "ACTIVE"
        )
        .eq(
          "published",
          true
        );


    /* -------------------------------------------------------
       COLLECTION
    ------------------------------------------------------- */

    if (
      normalizedCollection &&
      normalizedCollection !==
        "all"
    ) {
      query =
        query.filter(
          "collection_handle",
          "cs",
          `["${normalizedCollection}"]`
        );
    }


    const {
      data:
        allProducts,
      error
    } =
      await query;


    if (error) {
      console.error(
        "Supabase error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message
        });
    }


    if (
      !allProducts ||
      !allProducts.length
    ) {
      return res
        .status(200)
        .json({
          filters: {
            vendors: [],
            productTypes: [],
            colors: [],
            fabrics: [],
            delivery_timeline:
              [],
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


    /* =======================================================
       HIDE OUT-OF-STOCK FIRST

       This ensures filters are based only on products
       that can actually be purchased.
    ======================================================= */

    const inStockProducts =
      allProducts.filter(
        productIsInStock
      );


    let products = [
      ...inStockProducts
    ];


    /* =======================================================
       DESIGNER / VENDOR
    ======================================================= */

    if (vendor) {
      const selectedVendors =
        toList(vendor);

      products =
        products.filter(
          (product) =>
            selectedVendors.some(
              (selected) =>
                exactMatch(
                  product.vendor,
                  selected
                )
            )
        );
    }


    /* =======================================================
       PRODUCT TYPE
    ======================================================= */

    if (
      product_type
    ) {
      const selectedTypes =
        toList(
          product_type
        );

      products =
        products.filter(
          (product) =>
            selectedTypes.some(
              (selected) =>
                exactMatch(
                  product
                    .product_type,
                  selected
                )
            )
        );
    }


    /* =======================================================
       FABRIC
    ======================================================= */

    if (fabric) {
      const selectedFabrics =
        toList(fabric);

      products =
        products.filter(
          (product) => {

            const productFabrics =
              safeParse(
                product.fabric
              );

            return (
              selectedFabrics.some(
                (selected) =>
                  productFabrics.some(
                    (item) =>
                      exactMatch(
                        item,
                        selected
                      )
                  )
              )
            );
          }
        );
    }


    /* =======================================================
       PRICE
    ======================================================= */

    if (
      minPrice !==
        undefined ||
      maxPrice !==
        undefined
    ) {
      const minimum =
        minPrice !==
          undefined &&
        minPrice !==
          ""
          ? Number(
              minPrice
            )
          : null;

      const maximum =
        maxPrice !==
          undefined &&
        maxPrice !==
          ""
          ? Number(
              maxPrice
            )
          : null;


      products =
        products.filter(
          (product) => {

            const price =
              Number(
                product.price ||
                0
              );

            if (
              minimum !==
                null &&
              Number.isFinite(
                minimum
              ) &&
              price <
                minimum
            ) {
              return false;
            }

            if (
              maximum !==
                null &&
              Number.isFinite(
                maximum
              ) &&
              price >
                maximum
            ) {
              return false;
            }

            return true;
          }
        );
    }


    /* =======================================================
       COLOR

       Searches all product + variant colors.
    ======================================================= */

    if (color) {
      const selectedColors =
        toList(color);

      products =
        products.filter(
          (product) => {

            const productColors =
              getProductColors(
                product
              );

            return (
              selectedColors.some(
                (selected) =>
                  productColors.some(
                    (productColor) =>
                      colorMatch(
                        productColor,
                        selected
                      )
                  )
              )
            );
          }
        );
    }


    /* =======================================================
       SIZE

       IMPORTANT:
       Size must exist on an IN-STOCK variant.
    ======================================================= */

    if (size) {
      const selectedSizes =
        toList(size);

      products =
        products.filter(
          (product) => {

            const variants =
              getVariants(
                product
              );

            return (
              variants.some(
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
                    selectedSizes.some(
                      (selected) =>
                        exactMatch(
                          variantSize,
                          selected
                        )
                    )
                  );
                }
              )
            );
          }
        );
    }


    /* =======================================================
       DELIVERY TIMELINE
    ======================================================= */

    if (
      delivery_timeline
    ) {
      const selectedDeliveryTimes =
        toList(
          delivery_timeline
        );

      products =
        products.filter(
          (product) => {

            const productDeliveryTimes =
              safeParse(
                product
                  .delivery_timeline
              );

            return (
              selectedDeliveryTimes.some(
                (selected) =>
                  productDeliveryTimes.some(
                    (item) =>
                      exactMatch(
                        item,
                        selected
                      )
                  )
              )
            );
          }
        );
    }


    /* =======================================================
       FILTER SOURCE

       Filter options now correspond to the current result
       set after active filters.
    ======================================================= */

    const filterSource = [
      ...products
    ];


    /* =======================================================
       FORMAT PRODUCTS
    ======================================================= */

    let formattedProducts =
      products.map(
        (product) => ({
          ...product,

          price:
            Number(
              product.price ||
              0
            ),

          compare_at_price:
            Number(
              product
                .compare_at_price ||
              product
                .compareAtPrice ||
              product.mrp ||
              0
            ),

          /*
           * Return normalized combined colors too.
           */

          color:
            getProductColors(
              product
            )
        })
      );


    /* =======================================================
       SORT
    ======================================================= */

    const sortMap = {

      manual:
        (a, b) =>
          Number(
            a.position ??
            9999
          ) -
          Number(
            b.position ??
            9999
          ),


      "price-ascending":
        (a, b) =>
          a.price -
          b.price,


      "price-descending":
        (a, b) =>
          b.price -
          a.price,


      "title-ascending":
        (a, b) =>
          String(
            a.title ||
            ""
          ).localeCompare(
            String(
              b.title ||
              ""
            ),
            undefined,
            {
              sensitivity:
                "base"
            }
          ),


      "title-descending":
        (a, b) =>
          String(
            b.title ||
            ""
          ).localeCompare(
            String(
              a.title ||
              ""
            ),
            undefined,
            {
              sensitivity:
                "base"
            }
          ),


      "created-descending":
        (a, b) =>
          new Date(
            b.created_at ||
            0
          ) -
          new Date(
            a.created_at ||
            0
          ),


      "created-ascending":
        (a, b) =>
          new Date(
            a.created_at ||
            0
          ) -
          new Date(
            b.created_at ||
            0
          ),


      "best-selling":
        (a, b) =>
          Number(
            a
              .best_selling_rank ??
            999999
          ) -
          Number(
            b
              .best_selling_rank ??
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
        sortMap[
          sort_by
        ] ||
        (() => 0)
      );
    }


    /* =======================================================
       PAGINATION
    ======================================================= */

    const currentPage =
      Math.max(
        1,
        Number(page) ||
        1
      );

    const limit = 12;

    const total =
      formattedProducts.length;

    const totalPages =
      total
        ? Math.ceil(
            total /
            limit
          )
        : 0;


    const startIndex =
      (
        currentPage -
        1
      ) *
      limit;


    const paginatedProducts =
      formattedProducts.slice(
        startIndex,
        startIndex +
          limit
      );


    /* =======================================================
       BUILD FILTERS
    ======================================================= */

    const vendorSet =
      new Set();

    const typeSet =
      new Set();

    const colorValues =
      [];

    const fabricSet =
      new Set();

    const deliverySet =
      new Set();

    const sizeMap =
      new Map();


    filterSource.forEach(
      (product) => {


        /* ---------------------------------------------------
           VENDOR
        --------------------------------------------------- */

        if (
          product.vendor
        ) {
          vendorSet.add(
            String(
              product.vendor
            ).trim()
          );
        }


        /* ---------------------------------------------------
           PRODUCT TYPE
        --------------------------------------------------- */

        if (
          product
            .product_type
        ) {
          typeSet.add(
            String(
              product
                .product_type
            ).trim()
          );
        }


        /* ---------------------------------------------------
           COLORS

           Get ALL colors from:
           product.color + variants.
        --------------------------------------------------- */

        const productColors =
          getProductColors(
            product
          );

        colorValues.push(
          ...productColors
        );


        /* ---------------------------------------------------
           FABRIC
        --------------------------------------------------- */

        safeParse(
          product.fabric
        ).forEach(
          (item) => {

            const value =
              String(
                item ||
                ""
              ).trim();

            if (value) {
              fabricSet.add(
                value
              );
            }
          }
        );


        /* ---------------------------------------------------
           DELIVERY
        --------------------------------------------------- */

        safeParse(
          product
            .delivery_timeline
        ).forEach(
          (item) => {

            const value =
              String(
                item ||
                ""
              ).trim();

            if (value) {
              deliverySet.add(
                value
              );
            }
          }
        );


        /* ---------------------------------------------------
           SIZE

           Only add sizes that exist in variants.

           available tells frontend whether any variant
           for that size has inventory.
        --------------------------------------------------- */

        const variants =
          getVariants(
            product
          );

        for (
          const variant
          of variants
        ) {
          const variantSize =
            getVariantOption(
              variant,
              ["size"]
            );

          if (
            !variantSize
          ) {
            continue;
          }

          const normalizedSize =
            normalize(
              variantSize
            );

          if (
            !sizeMap.has(
              normalizedSize
            )
          ) {
            sizeMap.set(
              normalizedSize,
              {
                name:
                  variantSize,

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
            sizeMap.get(
              normalizedSize
            ).available =
              true;
          }
        }
      }
    );


    /* =======================================================
       DEDUPLICATE COLORS
    ======================================================= */

    const colors =
      uniqueValues(
        colorValues
          .map(
            standardizeColor
          )
          .filter(Boolean)
      );


    /* =======================================================
       OTHER FILTER VALUES
    ======================================================= */

    const vendors =
      uniqueValues([
        ...vendorSet
      ]);

    const productTypes =
      uniqueValues([
        ...typeSet
      ]);

    const fabrics =
      uniqueValues([
        ...fabricSet
      ]);

    const delivery =
      uniqueValues([
        ...deliverySet
      ]);

    const sizes =
      [
        ...sizeMap.values()
      ];


    /* =======================================================
       PRICE RANGE
    ======================================================= */

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


    /* =======================================================
       RESPONSE
    ======================================================= */

    return res
      .status(200)
      .json({

        filters: {

          vendors:
            vendors.length >
              1
              ? sortAlpha(
                  vendors
                ).map(
                  (name) => ({
                    name
                  })
                )
              : [],


          productTypes:
            productTypes.length >
              1
              ? sortAlpha(
                  productTypes
                ).map(
                  (name) => ({
                    name
                  })
                )
              : [],


          colors:
            colors.length >
              1
              ? sortAlpha(
                  colors
                ).map(
                  (name) => ({
                    name
                  })
                )
              : [],


          fabrics:
            fabrics.length >
              1
              ? sortAlpha(
                  fabrics
                )
              : [],


          delivery_timeline:
            delivery.length >
              1
              ? sortAlpha(
                  delivery
                )
              : [],


          sizes:
            sizes.length >
              1
              ? sizes
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
                          sensitivity:
                            "base",
                          numeric:
                            true
                        }
                      )
                  )
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

          currentPage,

          limit
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