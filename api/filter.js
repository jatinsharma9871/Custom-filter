import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
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
      fabric,
      delivery_timeline,
      page,
      sort_by
    } = req.query;

    const normalizedCollection = String(collection || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "");

    /* ================= FETCH ================= */

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
        pagination: { total: 0, totalPages: 0, currentPage: 1 }
      });
    }

    /* ================= HELPERS ================= */

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

    const normalize = (v) =>
      String(v || "").trim().toLowerCase();

    const sortAlpha = (arr) =>
      arr.sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );

    /* ================= FILTER PRODUCTS ================= */

    let products = [...allProducts];
    products = products.filter(p => {
  if (p.inventory_quantity > 0) return true;

  const variants = safeParse(p.variants);

  return variants.some(
    v => v.inventory_quantity > 0 || v.available === true
  );
});

    // vendor
    if (vendor) {
      const list = Array.isArray(vendor)
        ? vendor
        : vendor.split(",");

      products = products.filter(p =>
        list.some(v =>
          normalize(v) === normalize(p.vendor)
        )
      );
    }

    // product type
    if (product_type) {
      const list = Array.isArray(product_type)
        ? product_type
        : product_type.split(",");

      products = products.filter(p =>
        list.some(v =>
          normalize(v) === normalize(p.product_type)
        )
      );
    }

    // fabric
    if (fabric) {
      const list = Array.isArray(fabric)
        ? fabric
        : fabric.split(",");

      products = products.filter(p => {
        const pf = safeParse(p.fabric).map(normalize);
        return list.some(f => pf.includes(normalize(f)));
      });
    }

    // price
    if (minPrice || maxPrice) {
      products = products.filter(p => {
        const price = Number(p.price || 0);

        if (minPrice && price < Number(minPrice))
          return false;

        if (maxPrice && price > Number(maxPrice))
          return false;

        return true;
      });
    }

    // color
    if (color) {
      const list = Array.isArray(color)
        ? color
        : color.split(",");

      products = products.filter(p => {
        const pc = safeParse(p.color).map(normalize);
        const vc = safeParse(p.variants).map(v => normalize(v.color));

        return list.some(c =>
          pc.some(x => x.includes(normalize(c))) ||
          vc.some(x => x.includes(normalize(c)))
        );
      });
    }

    // delivery
    if (delivery_timeline) {
      const list = Array.isArray(delivery_timeline)
        ? delivery_timeline
        : delivery_timeline.split(",");

      products = products.filter(p => {
        const pd = safeParse(p.delivery_timeline).map(normalize);
        return list.some(t => pd.includes(normalize(t)));
      });
    }

    /* ================= FORMAT ================= */

    let formattedProducts = products.map(p => ({
      ...p,
      price: Number(p.price || 0),
      compare_at_price: Number(
        p.compare_at_price || p.compareAtPrice || p.mrp || 0
      )
    }));

    /* ================= SORT ================= */

    if (!sort_by) {
      formattedProducts.sort(
        (a, b) =>
          new Date(b.created_at) -
          new Date(a.created_at)
      );
    } else {

      const sortMap = {
        manual: (a, b) =>
          (a.position || 0) -
          (b.position || 0),

        "price-ascending": (a, b) =>
          a.price - b.price,

        "price-descending": (a, b) =>
          b.price - a.price,

        "title-ascending": (a, b) =>
          a.title?.localeCompare(b.title),

        "title-descending": (a, b) =>
          b.title?.localeCompare(a.title),

        "created-descending": (a, b) =>
          new Date(b.created_at) -
          new Date(a.created_at),

        "created-ascending": (a, b) =>
          new Date(a.created_at) -
          new Date(b.created_at)
      };

      formattedProducts.sort(
        sortMap[sort_by] || (() => 0)
      );
    }

    /* ================= PAGINATION ================= */

    const currentPage = Number(page) || 1;
    const limit = 12;

    const total = formattedProducts.length;
    const totalPages = Math.max(
      1,
      Math.ceil(total / limit)
    );

    const paginatedProducts =
      formattedProducts.slice(
        (currentPage - 1) * limit,
        currentPage * limit
      );

    /* ================= FILTER BUILD ================= */

    const vendorSet = new Set();
    const typeSet = new Set();
    const colorSet = new Set();
    const sizeAvailability = {};
    const fabricSet = new Set();
    const deliverySet = new Set();

    allProducts.forEach(p => {

      if (p.vendor)
        vendorSet.add(String(p.vendor).trim());

      if (p.product_type)
        typeSet.add(String(p.product_type).trim());

      safeParse(p.color).forEach(c => {
        if (c) colorSet.add(String(c).trim());
      });

      safeParse(p.fabric).forEach(f => {
        if (f) fabricSet.add(String(f).trim());
      });

      safeParse(p.delivery_timeline).forEach(d => {
        if (d) deliverySet.add(String(d).trim());
      });

      safeParse(p.variants).forEach(v => {
        if (!v.size) return;

        if (!sizeAvailability[v.size])
          sizeAvailability[v.size] = false;

        if (v.inventory_quantity > 0)
          sizeAvailability[v.size] = true;
      });

    });

    const vendors = [...vendorSet];
    const productTypes = [...typeSet];
    const colors = [...colorSet];
    const fabrics = [...fabricSet];
    const delivery = [...deliverySet];
    const sizes = Object.keys(sizeAvailability);

    return res.status(200).json({

      filters: {

        vendors:
          vendors.length > 1
            ? sortAlpha(vendors).map(v => ({ name: v }))
            : [],

        productTypes:
          productTypes.length > 1
            ? sortAlpha(productTypes).map(v => ({ name: v }))
            : [],

        colors:
          colors.length > 1
            ? sortAlpha(colors).map(v => ({ name: v }))
            : [],

        fabrics:
          fabrics.length > 1
            ? sortAlpha(fabrics)
            : [],

        delivery_timeline:
          delivery.length > 1
            ? sortAlpha(delivery)
            : [],

        sizes:
          sizes.length > 1
            ? sortAlpha(sizes).map(s => ({
                name: s,
                available: sizeAvailability[s]
              }))
            : [],

        priceRange: {
          min: Math.min(
            ...formattedProducts.map(
              p => p.price || 0
            )
          ),
          max: Math.max(
            ...formattedProducts.map(
              p => p.price || 0
            )
          )
        }
      },

      products: paginatedProducts,

      pagination: {
        total,
        totalPages,
        currentPage
      }

    });

  } catch (err) {

    console.error("API ERROR:", err);

    return res.status(500).json({
      error: err.message || "Server error"
    });
  }
}
