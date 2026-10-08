import { createClient } from "@supabase/supabase-js";


// ============================================================
// SUPABASE
// ============================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


// ============================================================
// PAGINATION
// ============================================================

const PAGE_LIMIT = 12;


// ============================================================
// FULL PRODUCT COLUMNS
//
// These are intentionally the same product fields your
// existing API returns.
//
// ============================================================

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


// ============================================================
// HANDLER
// ============================================================

export default async function handler(req, res) {

  // ==========================================================
  // CORS
  // ==========================================================

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


  // ==========================================================
  // OPTIONS
  // ==========================================================

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }


  // ==========================================================
  // ONLY GET
  // ==========================================================

  if (req.method !== "GET") {

    return res.status(405).json({
      error: "Method not allowed"
    });

  }


  try {

    // ========================================================
    // QUERY PARAMETERS
    // ========================================================

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


    // ========================================================
    // NORMALIZE COLLECTION
    //
    // Same behavior as your original code.
    // ========================================================

    const normalizedCollection =
      String(collection || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, "")
        || "all";


    // ========================================================
    // NORMALIZE SORT
    // ========================================================

    const normalizedSort =
      String(sort_by || "")
        .trim()
        .toLowerCase();


    // ========================================================
    // HELPERS
    // ========================================================

    const normalize = (value) =>

      String(value || "")
        .trim()
        .toLowerCase();


    const toList = (value) =>

      (
        Array.isArray(value)
          ? value
          : String(value || "").split(",")
      )

        .map(
          (item) =>
            String(item).trim()
        )

        .filter(Boolean);


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


    const currentPage =
      Math.max(
        1,
        Number(page) || 1
      );


    // ========================================================
    // FILTER OPTIONS
    //
    // SAME CACHE LOGIC AS ORIGINAL
    //
    // ========================================================

    let filters = {

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
        error: cacheError
      } = await supabase

        .from("filter_cache")

        .select("filters")

        .eq(
          "collection_handle",
          normalizedCollection
        )

        .maybeSingle();


      if (cacheError) {

        console.error(
          "Filter cache lookup error:",
          cacheError
        );

      }


      const cachedFilters =
        cacheRow?.filters || null;


      const normalizeCachedNames =
        (arr) =>

          (arr || []).map(
            (value) =>

              typeof value === "object"

                ? value

                : {
                    name: value
                  }
          );


      if (cachedFilters) {

        filters = {

          vendors:
            normalizeCachedNames(
              cachedFilters.vendors
            ),

          productTypes:
            normalizeCachedNames(
              cachedFilters.productTypes
            ),

          colors:
            normalizeCachedNames(
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

      }

    } catch (err) {

      // ======================================================
      // IMPORTANT:
      //
      // Filter cache failure must NEVER stop products.
      // ======================================================

      console.error(
        "Filter cache fetch threw:",
        err
      );

    }


    // ========================================================
    // PRODUCT RESPONSE
    // ========================================================

    let paginatedProducts = [];

    let total = 0;

    let productsError = null;


    try {

      // ======================================================
      // CONVERT FILTERS TO ARRAYS
      // ======================================================

      const selectedVendors =
        toList(vendor);


      const selectedProductTypes =
        toList(product_type);


      const selectedColors =
        toList(color);


      const selectedSizes =
        toList(size);


      const selectedFabrics =
        toList(fabric);


      const selectedDeliveryTimes =
        toList(
          delivery_timeline
        );


      // ======================================================
      // PRICE
      // ======================================================

      const parsedMinPrice =
        parseNumber(minPrice);


      const parsedMaxPrice =
        parseNumber(maxPrice);


      // ======================================================
      // DATABASE RPC
      //
      // IMPORTANT:
      //
      // The old implementation did:
      //
      //   Supabase -> ALL matching products
      //             -> Node filtering
      //             -> Node sorting
      //             -> Node pagination
      //
      // The new implementation does:
      //
      //   PostgreSQL
      //      -> filtering
      //      -> availability
      //      -> size
      //      -> sorting
      //      -> pagination
      //      -> only 12 products
      //
      // ======================================================

      const {
        data,
        error
      } = await supabase.rpc(
        "filter_products_paginated",
        {

          p_collection:
            normalizedCollection,


          p_min_price:
            parsedMinPrice,


          p_max_price:
            parsedMaxPrice,


          p_vendors:
            selectedVendors.length
              ? selectedVendors
              : null,


          p_product_types:
            selectedProductTypes.length
              ? selectedProductTypes
              : null,


          p_colors:
            selectedColors.length
              ? selectedColors
              : null,


          p_sizes:
            selectedSizes.length
              ? selectedSizes
              : null,


          p_fabrics:
            selectedFabrics.length
              ? selectedFabrics
              : null,


          p_delivery_timeline:
            selectedDeliveryTimes.length
              ? selectedDeliveryTimes
              : null,


          p_page:
            currentPage,


          p_limit:
            PAGE_LIMIT,


          p_sort_by:
            normalizedSort

        }
      );


      // ======================================================
      // RPC ERROR
      // ======================================================

      if (error) {

        console.error(
          "filter_products_paginated RPC error:",
          error
        );

        throw error;

      }


      // ======================================================
      // RPC RETURNS ONE ROW
      // ======================================================

      const result =
        Array.isArray(data)
          ? data[0]
          : data;


      // ======================================================
      // PRODUCTS
      // ======================================================

      let rpcProducts =
        result?.products || [];


      // Supabase may return JSONB as an object depending on
      // client/version, so normalize defensively.

      if (
        typeof rpcProducts === "string"
      ) {

        try {

          rpcProducts =
            JSON.parse(
              rpcProducts
            );

        } catch {

          rpcProducts = [];

        }

      }


      if (
        !Array.isArray(
          rpcProducts
        )
      ) {

        rpcProducts = [];

      }


      // ======================================================
      // TOTAL
      // ======================================================

      total =
        Number(
          result?.total || 0
        );


      // ======================================================
      // SANITIZE RESPONSE
      //
      // Keep same numeric conversion as original API.
      // ======================================================

      paginatedProducts =
        rpcProducts.map(
          (product) => {

            const {
              status,
              published,
              manual_position,
              row_number,
              ...rest
            } = product;


            return {

              ...rest,

              price:
                Number(
                  product.price || 0
                ),

              compare_at_price:
                Number(
                  product.compare_at_price || 0
                )

            };

          }
        );


    } catch (err) {

      // ======================================================
      // PRODUCT QUERY FAILURE
      //
      // Filters still return to frontend.
      // ======================================================

      console.error(
        "Product query error:",
        err
      );


      productsError =
        err.message ||
        "Failed to load products";

    }


    // ========================================================
    // TOTAL PAGES
    // ========================================================

    const totalPages =
      Math.max(
        1,
        Math.ceil(
          total / PAGE_LIMIT
        )
      );


    // ========================================================
    // FINAL RESPONSE
    //
    // SAME RESPONSE SHAPE AS YOUR ORIGINAL API
    // ========================================================

    return res.status(200).json({

      filters,

      products:
        paginatedProducts,

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

    // ========================================================
    // GLOBAL ERROR
    // ========================================================

    console.error(
      "API ERROR:",
      error
    );


    return res.status(500).json({

      error:
        error.message ||
        "Server error"

    });

  }

}