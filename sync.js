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

/* ================= COLLECTS CACHE ================= */

const collectsCache = {}; // { collectionId: { productId: position } }

async function getCollects(collectionId) {
  if (collectsCache[collectionId]) {
    return collectsCache[collectionId];
  }

  let url = `https://${SHOP}/admin/api/2024-01/collects.json?collection_id=${collectionId}&limit=250`;

  const map = {};

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": TOKEN
      }
    });

    const data = await res.json();

    (data.collects || []).forEach(c => {
      map[c.product_id] = c.position;
    });

    // pagination
    const link = res.headers.get("link");
    if (link && link.includes('rel="next"')) {
      url = link.match(/<([^>]+)>; rel="next"/)?.[1];
    } else {
      url = null;
    }
  }

  collectsCache[collectionId] = map;
  return map;
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
        createdAt
        publishedAt

        collections(first:200){
          edges{
            node{
              id
              handle
            }
          }
        }

        images(first:1){
          edges{
            node{ url }
          }
        }

        variants(first:100){
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

    const products = [];

    for (const p of data.data.products.edges) {

      const node = p.node;
      const productId = node.id.split("/").pop();

      /* ================= COLLECTIONS ================= */

      const collections = node.collections.edges.map(c => ({
        id: c.node.id.split("/").pop(),
        handle: c.node.handle
      }));

      /* ================= POSITION ================= */

      let positions = [];

      for (const col of collections) {
        const collectMap = await getCollects(col.id);
        if (collectMap[productId] !== undefined) {
          positions.push(collectMap[productId]);
        }
      }

      const position = positions.length ? Math.min(...positions) : 9999;

      /* ================= VARIANTS ================= */

      const variants = node.variants.edges.map(v => v.node);

      const variantData = variants.map(v => ({
        price: parseFloat(v.price || 0),
        inventory_quantity: v.inventoryQuantity || 0,
        color: v.selectedOptions?.find(o =>
          o.name.toLowerCase().includes("color")
        )?.value || "",
        size: v.selectedOptions?.find(o =>
          o.name.toLowerCase().includes("size")
        )?.value || ""
      }));

      /* ================= PRICE ================= */

      const price = variantData.length
        ? Math.min(...variantData.map(v => v.price))
        : 0;

      const totalInventory = variantData.reduce(
        (sum, v) => sum + (v.inventory_quantity || 0),
        0
      );

      /* ================= BUILD PRODUCT ================= */

      products.push({
        id: productId,
        title: node.title,
        handle: node.handle,
        vendor: node.vendor,
        product_type: node.productType,
        collection_handle: collections.map(c => c.handle),
        position,
        price,
        variants: variantData,
        image: node.images.edges[0]?.node.url || null,
        status: node.status,
        published: node.status === "ACTIVE",
        inventory_quantity: totalInventory,
        created_at: node.createdAt,
        published_at: node.publishedAt
      });
    }

    /* ================= UPSERT ================= */

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

  console.log("🎉 Sync complete!");
}

/* ================= RUN ================= */

syncProducts();