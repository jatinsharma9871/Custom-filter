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

    let query = supabase
      .from("products")
      .select("*")
      .eq("status", "ACTIVE")
      .eq("published", true);

    if (normalizedCollection && normalizedCollection !== "all") {
      query = query.filter(
        "collection_handle",
        "cs",
        `["${normalizedCollection}"]`
      );
    }

    const { data: allProducts, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!allProducts?.length) {
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

    // Designer
    if (vendor) {
      const selectedVendors = toList(vendor).map(normalize);

      products = products.filter((product) =>
        selectedVendors.includes(normalize(product.vendor))
      );
    }

    // Product type
    if (product_type) {
      const selectedTypes = toList(product_type).map(normalize);

      products = products.filter((product) =>
        selectedTypes.includes(normalize(product.product_type))
      );
    }

    // Fabric
    if (fabric) {
      const selectedFabrics = toList(fabric).map(normalize);

      products = products.filter((product) => {
        const productFabrics = safeParse(product.fabric).map(normalize);

        return selectedFabrics.some((selectedFabric) =>
          productFabrics.includes(selectedFabric)
        );
      });
    }

    // Price
    if (minPrice || maxPrice) {
      products = products.filter((product) => {
        const price = Number(product.price || 0);

        if (minPrice && price < Number(minPrice)) return false;
        if (maxPrice && price > Number(maxPrice)) return false;

        return true;
      });
    }

    // Color
    if (color) {
      const selectedColors = toList(color).map(normalize);

      products = products.filter((product) => {
       const productColors = safeParse(product.color)
  .flatMap(c => String(c).split(","))
  .map(c => c.trim().toLowerCase())
  .filter(Boolean);

      const variantColors = safeParse(product.variants)
  .flatMap(v => String(v?.color || "").split(","))
  .map(c => c.trim().toLowerCase())
  .filter(Boolean);
  return selectedColors.some(color =>
  productColors.includes(color) ||
  variantColors.includes(color)
);
       
      });
    }

    // Size — added
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
    const filterSource = [...products];

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

    /* ================= SORT ================= */

    const sortMap = {
      manual: (a, b) => Number(a.position || 0) - Number(b.position || 0),
      "price-ascending": (a, b) => a.price - b.price,
      "price-descending": (a, b) => b.price - a.price,
      "title-ascending": (a, b) =>
        String(a.title || "").localeCompare(String(b.title || "")),
      "title-descending": (a, b) =>
        String(b.title || "").localeCompare(String(a.title || "")),
      "created-descending": (a, b) =>
        new Date(b.created_at) - new Date(a.created_at),
      "created-ascending": (a, b) =>
        new Date(a.created_at) - new Date(b.created_at)
    };

    if (!sort_by) {
      formattedProducts.sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
    } else {
      formattedProducts.sort(sortMap[sort_by] || (() => 0));
    }

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

    const vendors = [...vendorSet];
    const productTypes = [...typeSet];
    const colors = [...colorSet];
    const fabrics = [...fabricSet];
    const delivery = [...deliverySet];
    const sizes = Object.keys(sizeAvailability);

    const productPrices = formattedProducts.map((product) => product.price);

    return res.status(200).json({
      filters: {
        vendors:
          vendors.length > 1
            ? sortAlpha(vendors).map((name) => ({ name }))
            : [],

        productTypes:
          productTypes.length > 1
            ? sortAlpha(productTypes).map((name) => ({ name }))
            : [],

        colors:
          colors.length > 1
            ? sortAlpha(colors).map((name) => ({ name }))
            : [],

        fabrics: fabrics.length > 1 ? sortAlpha(fabrics) : [],

        delivery_timeline: delivery.length > 1 ? sortAlpha(delivery) : [],

        sizes:
          sizes.length > 1
            ? sortAlpha(sizes).map((name) => ({
                name,
                available: sizeAvailability[name]
              }))
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