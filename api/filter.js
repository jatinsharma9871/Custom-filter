import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PAGE_LIMIT = 12;

export default async function handler(req, res) {
  // =====================================================
  // CORS
  // =====================================================

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // =====================================================
    // REQUEST PARAMETERS
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
      String(collection || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, "") || "all";

    // =====================================================
    // NORMALIZE SORT
    // =====================================================

    const normalizedSort = String(sort_by || "")
      .trim()
      .toLowerCase();

    // =====================================================
    // PAGE
    // =====================================================

    const currentPage = Math.max(1, Number(page) || 1);

    // =====================================================
    // HELPERS
    // =====================================================

    const toList = (value) => {
      if (Array.isArray(value)) {
        return value
          .map((item) => String(item).trim())
          .filter(Boolean);
      }

      return String(value || "")
        .split(",")
        .map((item) => String(item).trim())
        .filter(Boolean);
    };

    const parsePrice = (value) => {
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        Number.isNaN(Number(value))
      ) {
        return null;
      }

      return Number(value);
    };

    // =====================================================
    // FILTER ARRAYS
    // =====================================================

    const selectedVendors = toList(vendor);
    const selectedProductTypes = toList(product_type);
    const selectedColors = toList(color);
    const selectedSizes = toList(size);
    const selectedFabrics = toList(fabric);
    const selectedDeliveryTimeline = toList(delivery_timeline);

    // =====================================================
    // PRICE
    // =====================================================

    const parsedMinPrice = parsePrice(minPrice);
    const parsedMaxPrice = parsePrice(maxPrice);

    // =====================================================
    // FILTER CACHE
    //
    // Keep this independent from product loading.
    // If product RPC fails, filters can still render.
    // =====================================================

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
        .eq("collection_handle", normalizedCollection)
        .maybeSingle();

      if (cacheError) {
        console.error(
          "Filter cache lookup error:",
          cacheError
        );
      }

      const cachedFilters = cacheRow?.filters || null;

      const normalizeCachedNames = (arr) =>
        (arr || []).map((value) =>
          typeof value === "object"
            ? value
            : { name: value }
        );

      if (cachedFilters) {
        filters = {
          vendors: normalizeCachedNames(
            cachedFilters.vendors
          ),

          productTypes: normalizeCachedNames(
            cachedFilters.productTypes
          ),

          colors: normalizeCachedNames(
            cachedFilters.colors
          ),

          fabrics: cachedFilters.fabrics || [],

          delivery_timeline:
            cachedFilters.delivery_timeline || [],

          sizes: cachedFilters.sizes || [],

          priceRange:
            cachedFilters.priceRange || {
              min: 0,
              max: 0
            }
        };
      }
    } catch (err) {
      console.error(
        "Filter cache fetch threw:",
        err
      );
    }

    // =====================================================
    // CALL SUPABASE RPC
    //
    // All expensive product filtering, availability,
    // size filtering, sorting and pagination now happens
    // inside PostgreSQL.
    // =====================================================

    const {
      data: rpcData,
      error: rpcError
    } = await supabase.rpc(
      "filter_products_paginated",
      {
        p_collection: normalizedCollection,

        p_min_price: parsedMinPrice,

        p_max_price: parsedMaxPrice,

        p_vendor: selectedVendors,

        p_product_type: selectedProductTypes,

        p_color: selectedColors,

        p_size: selectedSizes,

        p_fabric: selectedFabrics,

        p_delivery_timeline:
          selectedDeliveryTimeline,

        p_page: currentPage,

        p_limit: PAGE_LIMIT,

        p_sort_by: normalizedSort
      }
    );

    // =====================================================
    // RPC ERROR
    // =====================================================

    if (rpcError) {
      console.error(
        "Supabase RPC error:",
        rpcError
      );

      return res.status(500).json({
        filters,

        products: [],

        pagination: {
          total: 0,
          totalPages: 1,
          currentPage
        },

        productsError:
          rpcError.message ||
          "Failed to load products"
      });
    }

    // =====================================================
    // RPC RESPONSE
    // =====================================================

    const rpcResult =
      rpcData || {
        total: 0,
        products: []
      };

    const products = Array.isArray(
      rpcResult.products
    )
      ? rpcResult.products
      : [];

    const total = Number(
      rpcResult.total || 0
    );

    const totalPages = Math.max(
      1,
      Math.ceil(total / PAGE_LIMIT)
    );

    // =====================================================
    // FINAL RESPONSE
    //
    // Keeps the same structure your frontend already uses.
    // =====================================================

    return res.status(200).json({
      filters,

      products,

      pagination: {
        total,

        totalPages,

        currentPage
      }
    });

  } catch (error) {
    // =====================================================
    // OUTER ERROR
    // =====================================================

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