import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* ================= CONFIG ================= */

const SHOP = "the-sverve.myshopify.com";
const TOKEN = "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";

const supabase = createClient(
  "https://rflabvnooobawvhxkuoi.supabase.co",
  "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5"
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================= SHOPIFY FETCH ================= */

async function shopifyFetch(query) {
  try {
    const res = await fetch(
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

    const json = await res.json();

    if (!res.ok || json.errors) {
      console.error("❌ Shopify Error:", json.errors);
      throw new Error("Shopify API failed");
    }

    return json;

  } catch (err) {
    console.error("❌ Fetch failed:", err.message);
    throw err;
  }
}

/* ================= MAIN SYNC ================= */

async function syncProducts() {

  console.log("🚀 STARTING SYNC...\n");

  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;

  const allProducts = [];
  const allCollectionIds = new Set();

  /* ===== STEP 1: FETCH PRODUCTS ===== */

  while (hasNextPage) {

    pageCount++;

    console.log(`📦 Fetching page ${pageCount}...`);

    const query = `
    {
      products(first:250 ${cursor ? `, after:"${cursor}"` : ""}) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            status
            createdAt
            publishedAt

            collections(first:50){
              edges{
                node{ id handle }
              }
            }

            images(first:1){
              edges{ node{ url } }
            }

            variants(first:50){
              edges{
                node{
                  price
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }`;

    const data = await shopifyFetch(query);

    const edges = data?.data?.products?.edges || [];

    console.log(`➡️ Products in page ${pageCount}:`, edges.length);

    edges.forEach(p => {
      const node = p.node;

      const collections = node.collections.edges.map(c => {
        const id = c.node.id.split("/").pop();
        allCollectionIds.add(id);
        return {
          id,
          handle: c.node.handle
        };
      });

      allProducts.push({ node, collections });
    });

    console.log(`📊 Total products so far: ${allProducts.length}\n`);

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;

    await sleep(600);
  }

  console.log("✅ TOTAL PRODUCTS FETCHED:", allProducts.length);

  /* ===== STEP 2: FETCH COLLECTS ===== */

  console.log("\n📦 Fetching collection positions...");

  const collectsMap = {};

  for (const id of allCollectionIds) {

    console.log(`➡️ Fetching collects for collection ${id}`);

    let url = `https://${SHOP}/admin/api/2024-01/collects.json?collection_id=${id}&limit=250`;
    collectsMap[id] = {};

    while (url) {
      const res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": TOKEN }
      });

      const data = await res.json();

      (data.collects || []).forEach(c => {
        collectsMap[id][c.product_id] = c.position;
      });

      const link = res.headers.get("link");
      url = link?.includes("next")
        ? link.match(/<([^>]+)>; rel="next"/)?.[1]
        : null;
    }

    await sleep(300);
  }

  console.log("✅ Collects fetched\n");

  /* ===== STEP 3: BUILD PRODUCTS ===== */

  console.log("⚙️ Processing products...");

  const finalProducts = allProducts.map(p => {

    const node = p.node;
    const productId = node.id.split("/").pop();

    const positions = p.collections.map(c =>
      collectsMap[c.id]?.[productId]
    ).filter(Boolean);

    const position = positions.length
      ? Math.min(...positions)
      : Number.MAX_SAFE_INTEGER;

    const variants = node.variants.edges.map(v => v.node);

    const price = variants.length
      ? Math.min(...variants.map(v => parseFloat(v.price)))
      : 0;

    const inventory = variants.reduce(
      (sum, v) => sum + (v.inventoryQuantity || 0),
      0
    );

    return {
      id: productId,
      title: node.title,
      handle: node.handle,
      vendor: node.vendor,
      product_type: node.productType,
      collection_handle: p.collections.map(c => c.handle),

      position,
      price,
      image: node.images.edges[0]?.node.url || null,

      inventory_quantity: inventory,
      status: node.status,
      published: node.status === "ACTIVE",

      created_at: node.createdAt,
      published_at: node.publishedAt
    };
  });

  console.log("✅ Processed products:", finalProducts.length);

  /* ===== STEP 4: UPSERT ===== */

  console.log("\n⬆️ Uploading to Supabase...");

  const { error } = await supabase
    .from("products")
    .upsert(finalProducts, { onConflict: "id" });

  if (error) {
    console.error("❌ SUPABASE ERROR:", error.message);
    return;
  }

  console.log("🎉 SYNC COMPLETE:", finalProducts.length);
}

/* ================= RUN ================= */

syncProducts().catch(err => {
  console.error("🔥 FINAL ERROR:", err);
});