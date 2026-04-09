import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* ================= CONFIG ================= */

const SHOP = "the-sverve.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================= SHOPIFY FETCH ================= */

async function shopifyFetch(query) {
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
    console.error("Shopify Error:", json.errors);
    throw new Error("Shopify API failed");
  }

  return json;
}

/* ================= FETCH COLLECTS ================= */

async function fetchAllCollects(collectionIds) {
  const result = {};

  for (const id of collectionIds) {

    let url =
      `https://${SHOP}/admin/api/2024-01/collects.json?collection_id=${id}&limit=250`;

    result[id] = {};

    while (url) {
      const res = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": TOKEN
        }
      });

      const data = await res.json();

      (data.collects || []).forEach(c => {
        result[id][c.product_id] = c.position;
      });

      const link = res.headers.get("link");

      url = link?.includes("next")
        ? link.match(/<([^>]+)>; rel="next"/)?.[1]
        : null;
    }

    await sleep(200);
  }

  return result;
}

/* ================= BEST SELLING ================= */

async function fetchBestSelling() {

  const COLLECTION_ID = "gid://shopify/Collection/309319958621";

  let hasNextPage = true;
  let cursor = null;
  let rank = 1;

  const map = {};

  while (hasNextPage) {

    const query = `
    {
      collection(id: "${COLLECTION_ID}") {
        products(
          first: 250
          sortKey: BEST_SELLING
          ${cursor ? `, after:"${cursor}"` : ""}
        ) {
          pageInfo { hasNextPage endCursor }
          edges { node { id } }
        }
      }
    }`;

    const data = await shopifyFetch(query);
    const products = data.data.collection.products;

    products.edges.forEach(p => {
      const id = p.node.id.split("/").pop();
      map[id] = rank++;
    });

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;

    await sleep(400);
  }

  return map;
}

/* ================= MAIN SYNC ================= */

async function syncProducts() {

  let hasNextPage = true;
  let cursor = null;

  const allProducts = [];
  const allCollectionIds = new Set();

  /* ===== FETCH PRODUCTS ===== */

  while (hasNextPage) {

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

            metafields(first: 20) {
              edges {
                node {
                  key
                  value
                  namespace
                }
              }
            }

            collections(first:150){
              edges{
                node{ id handle }
              }
            }

            images(first:5){
              edges{
                node{ url }
              }
            }

            variants(first:150){
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
    const edges = data.data.products.edges;

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

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;

    await sleep(500);
  }

  /* ===== COLLECTS ===== */

  const collectsMap =
    await fetchAllCollects([...allCollectionIds]);

  /* ===== BEST SELLING ===== */

  const bestSellingMap =
    await fetchBestSelling();

  /* ===== PROCESS ===== */

  const finalProducts = allProducts.map(p => {

    const node = p.node;
    const productId =
      node.id.split("/").pop();

    const positions = p.collections
      .map(c => collectsMap[c.id]?.[productId])
      .filter(Boolean);

    const position =
      positions.length
        ? Math.min(...positions)
        : 9999;

    const variants =
      node.variants.edges.map(v => v.node);

    const price = variants.length
      ? Math.min(
          ...variants.map(v =>
            parseFloat(v.price)
          )
        )
      : 0;

    const inventory =
      variants.reduce(
        (sum, v) =>
          sum + (v.inventoryQuantity || 0),
        0
      );

    const metafields =
      node.metafields?.edges || [];

    const deliveryTimeline =
      metafields.find(
        m =>
          m.node.namespace === "custom" &&
          m.node.key === "delivery_time"
      )?.node.value || null;

    /* ===== IMAGES ===== */

    const images =
      node.images.edges.map(
        i => i.node.url
      );

    return {

      id: productId,
      title: node.title,
      handle: node.handle,
      vendor: node.vendor,
      product_type: node.productType,
      collection_handle:
        p.collections.map(c => c.handle),

      position,
      best_selling_rank:
        bestSellingMap[productId] ?? 9999,

      price,

      // ✅ images
      image: images[0] || null,
      images: images,

      inventory_quantity: inventory,
      status: node.status,
      published: node.status === "ACTIVE",

      delivery_timeline: deliveryTimeline,

      created_at: node.createdAt,
      published_at: node.publishedAt
    };
  });

  /* ===== UPLOAD ===== */

  const chunkSize = 500;

  for (
    let i = 0;
    i < finalProducts.length;
    i += chunkSize
  ) {

    const chunk =
      finalProducts.slice(
        i,
        i + chunkSize
      );

    const { error } =
      await supabase
        .from("products")
        .upsert(chunk, {
          onConflict: "id"
        });

    if (error) {
      console.error(
        "Batch error:",
        error.message
      );
      return;
    }

    await sleep(150);
  }

  console.log(
    "SYNC COMPLETE:",
    finalProducts.length
  );
}

/* ================= RUN ================= */

syncProducts().catch(err => {
  console.error("FINAL ERROR:", err);
});
