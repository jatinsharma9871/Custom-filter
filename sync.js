import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* ================= CONFIG ================= */

const SHOP = "the-sverve.myshopify.com";
const TOKEN = "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";

const supabase = createClient(
  "https://rflabvnooobawvhxkuoi.supabase.co",
  "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5"
);

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopifyFetch(query, retries = 3) {
  try {
    const response = await fetch(
      `https://${SHOP}/admin/api/2024-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query })
      }
    );

    const json = await response.json();

    if (!response.ok || json.errors) {
      throw new Error(JSON.stringify(json.errors));
    }

    return json;

  } catch (err) {
    if (retries > 0) {
      console.log("🔁 Retrying Shopify request...");
      await sleep(2000);
      return shopifyFetch(query, retries - 1);
    }
    throw err;
  }
}

/* ================= SYNC ================= */

async function syncProducts() {

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {

    const query = `
{
  products(first:250 ${cursor ? `, after:"${cursor}"` : ""}) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        title
        handle
        vendor
        productType
        status
        tags

        metafield(namespace: "custom", key: "color") {
          value
        }

        collections(first:10){
          edges{
            node{ handle }
          }
        }

        images(first:1){
          edges{
            node{ url }
          }
        }

        variants(first:1){
          edges{
            node{
              price
              inventoryQuantity
              selectedOptions{
                name
                value
              }
            }
          }
        }
      }
    }
  }
}
`;

    console.log("📦 Fetching products...");

    const data = await shopifyFetch(query);

    /* ---------- TRANSFORM ---------- */
    const products = data.data.products.edges.map(p => {

      const tags = p.node.tags || [];
      const variant = p.node.variants.edges[0]?.node;

      let size = [];
      let color = [];
      let fabric = [];
      let delivery_time = [];

      /* ================= COLOR ================= */

      if (p.node.metafield?.value) {
        try {
          const parsed = JSON.parse(p.node.metafield.value);
          color = Array.isArray(parsed)
            ? parsed.map(c => c.trim())
            : [parsed.trim()];
        } catch {
          color = p.node.metafield.value
            .split(",")
            .map(c => c.trim());
        }
      }

      /* VARIANT FALLBACK */
      variant?.selectedOptions?.forEach(opt => {

        const name = opt.name.toLowerCase();

        if (!color.length && name.includes("color")) {
          color = opt.value.split("/").map(c => c.trim());
        }

        if (name.includes("size")) {
          size.push(opt.value.trim());
        }

      });

      /* ================= FABRIC (FIXED) ================= */

      // 1. Fabric_Cotton
      const fabricTag = tags.find(t =>
        t.toLowerCase().startsWith("fabric_")
      );

      if (fabricTag) {
        fabric = fabricTag
          .split("_")[1]
          .split(",")
          .map(f => f.trim());
      }

      // 2. fallback: detect from normal tags
      if (!fabric.length) {

        const fabricKeywords = [
          "cotton","silk","linen","wool","denim",
          "polyester","rayon","chiffon","georgette","velvet"
        ];

        fabric = tags.filter(t =>
          fabricKeywords.includes(t.toLowerCase())
        );
      }

      /* ================= DELIVERY ================= */

      const deliveryTag = tags.find(t =>
        t.toLowerCase().startsWith("delivery_")
      );

      if (deliveryTag) {
        delivery_time = deliveryTag
          .split("_")[1]
          .split(",")
          .map(d => d.trim());
      }

      /* ================= CLEAN ================= */

      color = [...new Set(color)];
      size = [...new Set(size)];
      fabric = [...new Set(fabric)];
      delivery_time = [...new Set(delivery_time)];

      const collections =
        p.node.collections.edges.map(c => c.node.handle);

      return {

        id: p.node.id.split("/").pop(),

        title: p.node.title,
        handle: p.node.handle,
        vendor: p.node.vendor,

        product_type: p.node.productType,
        collection_handle: collections,

        price: parseFloat(variant?.price || 0),

        image: p.node.images.edges[0]?.node.url || null,

        status: p.node.status,
        published: p.node.status === "ACTIVE",
        inventory_quantity: variant?.inventoryQuantity || 0,

        /* FILTER FIELDS */
        color,
        size,
        fabric,
        delivery_time

      };

    });

    /* ---------- UPSERT ---------- */
    const { error } = await supabase
      .from("products")
      .upsert(products, { onConflict: "id" });

    if (error) {
      console.error("❌ SUPABASE ERROR:", error.message);
      return;
    }

    console.log("✅ Inserted:", products.length);

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;

    await sleep(1200);
  }

  console.log("🎉 All products synced successfully!");
}

/* ================= RUN ================= */

syncProducts();