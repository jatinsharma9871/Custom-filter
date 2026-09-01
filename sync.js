import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

/* =========================================================
   CONFIG
========================================================= */
const PAGE_SIZE = 250;
const SHOP = process.env.SHOPIFY_STORE || "the-sverve.myshopify.com";

let TOKEN = null;
let TOKEN_EXPIRES = 0;

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

const supabase = createClient(
  process.env.SUPABASE_URL || "https://rflabvnooobawvhxkuoi.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5"
);

if (!SHOP) {
  throw new Error("Missing SHOPIFY_STORE env var.");
}
if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
  throw new Error("Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars.");
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
}

async function getAccessToken() {
  if (TOKEN && Date.now() < TOKEN_EXPIRES - 60000) {
    return TOKEN;
  }

  console.log("Generating new Shopify token...");

  const response = await fetch(
    `https://${SHOP}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.SHOPIFY_CLIENT_ID || "53dfed9eb56ffec51c0f8e66178afb55",
        client_secret: process.env.SHOPIFY_CLIENT_SECRET || "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"
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Token request failed: ${response.status}`
    );
  }

  const tokenData = await response.json();

  TOKEN = tokenData.access_token;
  TOKEN_EXPIRES = Date.now() + tokenData.expires_in * 1000;

  await supabase
    .from("shopify_token")
    .upsert({
      id: 1,
      access_token: TOKEN,
      expires_at: new Date(TOKEN_EXPIRES).toISOString(),
      updated_at: new Date().toISOString()
    });

  return TOKEN;
}

/* =========================================================
   HELPERS
========================================================= */

function extractTag(tags, prefix) {
  if (!Array.isArray(tags)) return null;

  const tag = tags.find((t) =>
    t.toLowerCase().startsWith(
      prefix.toLowerCase() + "_"
    )
  );

  if (!tag) return null;

  return tag.substring(prefix.length + 1).trim();
}

function getFirstImage(images) {
  return (
    images?.edges?.[0]?.node?.url ||
    null
  );
}

function getAllImages(images) {
  return (
    images?.edges
      ?.map((e) => e.node.url)
      .filter(Boolean) || []
  );
}

function getPrice(variants) {
  return Number.parseFloat(
    variants?.edges?.[0]?.node?.price || 0
  );
}

async function shopifyRequest(query, variables = {}) {
  const token = await getAccessToken();
  const response = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  // Handle Shopify rate limiting
  if (response.status === 401) {
    throw new Error(
      "Shopify access token is invalid or expired."
    );
  }
  if (response.status === 429) {
    const retryAfter =
      Number(response.headers.get("Retry-After")) || 2;

    console.log(
      `⚠️ Rate limited. Waiting ${retryAfter} seconds...`
    );

    await new Promise(resolve =>
      setTimeout(resolve, retryAfter * 1000)
    );

    return shopifyRequest(query, variables);
  }
  const text = await response.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid Shopify response:\n${text}`);
  }

  if (!response.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }

  if (json.errors?.length) {
    console.error(json.errors);
    throw new Error("Shopify GraphQL Error");
  }

  return json;
}
/* =========================================================
   GRAPHQL QUERY
========================================================= */

const PRODUCT_QUERY = `
query GetProducts($cursor: String) {
  products(first: ${PAGE_SIZE}, after: $cursor) {
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
        tags
        status
        publishedAt
        metafield(namespace: "custom", key: "color1") {
          value
        }

        images(first: 20) {
          edges {
            node {
              url
            }
          }
        }
        collections(first: 250) {
          edges {
            node {
              handle
            }
          }
        }
        variants(first: 250) {
          edges {
            node {
              price
              compareAtPrice
              inventoryQuantity
              availableForSale
              selectedOptions {
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

/* =========================================================
   COLLECTION SEQUENCING (mirrors whatever order/sequencing
   the out-of-stock app has already written back to Shopify)
========================================================= */

const COLLECTIONS_QUERY = `
query GetCollections($cursor: String) {
  collections(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node { handle } }
  }
}
`;

const COLLECTION_PRODUCT_ORDER_QUERY = `
query GetCollectionProductOrder($handle: String!, $cursor: String) {
  collectionByHandle(handle: $handle) {
    products(first: 250, after: $cursor, sortKey: COLLECTION_DEFAULT) {
      pageInfo { hasNextPage endCursor }
      edges { node { id } }
    }
  }
}
`;

async function fetchAllCollectionHandles() {
  let handles = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyRequest(COLLECTIONS_QUERY, { cursor });
    const conn = data.data.collections;

    handles.push(...conn.edges.map(e => e.node.handle));

    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return handles;
}

// Returns { [productId]: positionIndex } for a single collection, in
// whatever order Shopify's own COLLECTION_DEFAULT sort currently has —
// which is exactly the order the sequencing app has already applied.
async function fetchCollectionProductOrder(handle) {
  let order = {};
  let cursor = null;
  let hasNextPage = true;
  let index = 0;

  while (hasNextPage) {
    const data = await shopifyRequest(
      COLLECTION_PRODUCT_ORDER_QUERY,
      { handle, cursor }
    );

    const collection = data.data.collectionByHandle;
    if (!collection) break;

    const conn = collection.products;

    conn.edges.forEach(({ node }) => {
      order[node.id] = index++;
    });

    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return order;
}

// { [collectionHandle]: { [productId]: positionIndex } } across every
// collection in the store. This is what makes the custom filter grid's
// default order match the native Shopify collection page, sequencing
// app and all — we don't try to replicate the app's push-down logic
// ourselves, we just mirror the order it has already written to Shopify.
async function fetchAllCollectionProductOrders() {
  console.log("\nFetching collection sequencing from Shopify...");

  const handles = await fetchAllCollectionHandles();
  console.log(`Found ${handles.length} collections`);

  const ordersByHandle = {};

  for (const handle of handles) {
    try {
      ordersByHandle[handle] = await fetchCollectionProductOrder(handle);
    } catch (err) {
      console.error(`Failed to fetch sequencing for "${handle}":`, err.message);
      ordersByHandle[handle] = {};
    }
  }

  console.log("✅ Collection sequencing fetched\n");

  return ordersByHandle;
}

/* =========================================================
   SYNC
========================================================= */

async function syncProducts() {

  try {

    console.log("================================");
    console.log("Starting Shopify Sync...");
    console.log("================================");

    // Fetched once up front so every product below can look up its
    // position within each collection it belongs to.
    let collectionOrders = {};
    try {
      collectionOrders = await fetchAllCollectionProductOrders();
    } catch (err) {
      console.error("⚠️ Could not fetch collection sequencing (continuing without it):", err.message);
    }

    let hasNextPage = true;
    let cursor = null;

    let totalSynced = 0;
    let batch = 1;

    while (hasNextPage) {

      console.log(
        `Fetching Batch ${batch}...`
      );

      const data = await shopifyRequest(
        PRODUCT_QUERY,
        {
          cursor,
        }
      );

      if (data.extensions?.cost) {
        console.log(
          `API Cost: ${data.extensions.cost.requestedQueryCost} | Available: ${data.extensions.cost.throttleStatus.currentlyAvailable}`
        );
      }

      const productConnection = data.data.products;

      const edges =
        productConnection.edges;

      hasNextPage =
        productConnection.pageInfo.hasNextPage;

      cursor =
        productConnection.pageInfo.endCursor;

      console.log(
        `Batch ${batch}: Received ${edges.length} products`
      );
      const products = edges.map(({ node }) => {

        const tags = node.tags || [];

        const colors = new Set();
        const rawColor = node.metafield?.value;

        if (rawColor) {
          try {
            const parsed = JSON.parse(rawColor);

            if (Array.isArray(parsed)) {
              parsed.forEach(color => {
                if (color) {
                  colors.add(String(color).trim());
                }
              });
            } else if (parsed) {
              colors.add(String(parsed).trim());
            }

          } catch {
            colors.add(String(rawColor).trim());
          }
        }

        const variants = node.variants.edges.map(({ node: variant }) => ({
          price: Number(variant.price),
          compare_at_price: Number(variant.compareAtPrice || 0),
          inventory_quantity: Number(variant.inventoryQuantity || 0),
          available: Boolean(variant.availableForSale),

          options: variant.selectedOptions,

          color:
            variant.selectedOptions.find(
              o => o.name.toLowerCase() === "color"
            )?.value || null,

          size:
            variant.selectedOptions.find(
              o => o.name.toLowerCase() === "size"
            )?.value || null
        }));

        const collectionHandles =
          node.collections?.edges?.map(c => c.node.handle) || [];
        if (!collectionHandles.length) {
          console.warn(
            "No collections:",
            node.title,
            node.handle
          );
        }

        // { [collectionHandle]: positionIndex } — only for collections
        // where this product actually appears in the fetched order (an
        // out-of-stock item the app has hidden from a collection simply
        // won't have an entry here, which is correct).
        const collectionPositions = {};
        collectionHandles.forEach(handle => {
          const orderMap = collectionOrders[handle];
          if (orderMap && Object.prototype.hasOwnProperty.call(orderMap, node.id)) {
            collectionPositions[handle] = orderMap[node.id];
          }
        });

        return {
          id: node.id,

          title: node.title,

          handle: node.handle,

          vendor: node.vendor,

          product_type: node.productType,

          collection: node.productType,

          collection_handle: collectionHandles,

          price: getPrice(node.variants),
          variants: JSON.stringify(variants),

          inventory_quantity: variants.reduce(
            (sum, v) => sum + v.inventory_quantity,
            0
          ),

          published: Boolean(node.publishedAt),

          status: node.status,

          compare_at_price:
            Number.parseFloat(
              node.variants?.edges?.[0]?.node?.compareAtPrice || 0
            ),

          image: getFirstImage(node.images),

          images: JSON.stringify(getAllImages(node.images)),

          color: JSON.stringify([...colors]),

          size: extractTag(tags, "Size"),

          fabric: extractTag(tags, "Fabric"),

          delivery_timeline: extractTag(tags, "Delivery"),

          collection_positions: JSON.stringify(collectionPositions),

        };

      });

      console.log(
        `Prepared ${products.length} products`
      );
      let retries = 3;

      while (retries > 0) {

        const { error } = await supabase
          .from("products")
          .upsert(
            products,
            {
              onConflict: "id",
              ignoreDuplicates: false,
            }
          );

        if (!error) {
          break;
        }

        retries--;

        console.error(
          `Supabase Upsert Failed (${3 - retries}/3)`
        );

        console.error(error);

        if (retries === 0) {
          throw error;
        }

        console.log(
          "Retrying in 2 seconds..."
        );

        await new Promise(resolve =>
          setTimeout(resolve, 2000)
        );
      }

      totalSynced += products.length;

      console.log(
        `✓ Batch ${batch} Complete`
      );

      console.log(
        `✓ Total Synced: ${totalSynced}`
      );

      console.log(
        "--------------------------------"
      );

      batch++;
    } // End while

    // Filter cache rebuild is wrapped separately: a problem here should
    // never make the product sync itself look "failed" in history, since
    // the products upsert above already succeeded.
    let filterCacheOk = true;
    try {
      await buildFilterCache();
    } catch (err) {
      filterCacheOk = false;
      console.error("\n⚠️ Filter cache rebuild failed (products still synced):");
      console.error(err);
    }

    console.log("\n================================");
    console.log("✅ Shopify Sync Completed");
    console.log(`📦 Total Products Synced: ${totalSynced}`);
    if (!filterCacheOk) {
      console.log("⚠️ Filter cache rebuild FAILED this run — filters may be stale.");
    }
    console.log("================================\n");

    return { success: true, totalSynced, filterCacheOk };

  } catch (error) {

    console.error("\n================================");
    console.error("❌ Shopify Sync Failed");
    console.error("================================");

    console.error(error);

    return { success: false, error: error.message };
  }
}
/* =========================================================
   BUILD FILTER CACHE
========================================================= */

// Fetches every active/published product needed to build the filter
// cache in small paginated batches instead of one unbounded query.
// A single unpaginated select over the whole catalog is what was
// timing out and silently leaving filter_cache stale/empty for some
// collections — this keeps each round-trip small and fast regardless
// of how large the catalog grows.
async function fetchActiveProductsForFilterCache() {
  const BATCH_SIZE = 500;
  let from = 0;
  let all = [];

  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select(`
title,
collection_handle,
vendor,
product_type,
color,
fabric,
delivery_timeline,
price,
variants,
status,
published
`)
      .ilike("status", "active")
      .eq("published", true)
      .order("id", { ascending: true })
      .range(from, from + BATCH_SIZE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    all = all.concat(data);

    if (data.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }

  return all;
}

async function buildFilterCache() {
  console.log("\nBuilding Filter Cache...");

  const products = await fetchActiveProductsForFilterCache();

  console.log(`Fetched ${products.length} active/published products for filter cache`);

  const collections = {};

  // "all" aggregates every active/published product regardless of collection,
  // so requests for collection=all can also be served from the cache.
  collections["all"] = {
    vendors: new Set(),
    productTypes: new Set(),
    colors: new Set(),
    fabrics: new Set(),
    delivery: new Set(),
    sizes: new Set(),
    prices: []
  };

  const addValues = (value, set) => {
    if (!value) return;

    let arr = [];

    try {
      arr = Array.isArray(value)
        ? value
        : JSON.parse(value);
    } catch {
      arr = String(value).split(",");
    }

    arr
      .flatMap(v => {
        if (typeof v === "object" && v !== null) {
          return Object.values(v);
        }

        return String(v).split(",");
      })
      .map(v => v.trim())
      .filter(Boolean)
      .forEach(v => set.add(v));
  };

  const applyProductToBucket = (c, product) => {
    if (product.vendor)
      c.vendors.add(product.vendor.trim());

    if (product.product_type)
      c.productTypes.add(product.product_type.trim());

    if (product.price)
      c.prices.push(Number(product.price));

    addValues(product.color, c.colors);
    addValues(product.fabric, c.fabrics);
    addValues(product.delivery_timeline, c.delivery);

    let variants = [];

    try {
      variants = JSON.parse(product.variants || "[]");
    } catch {}

    variants.forEach((variant) => {
      if (
        variant.size &&
        (variant.available || variant.inventory_quantity > 0)
      ) {
        c.sizes.add(variant.size.trim());
      }
    });
  };

  for (const product of products) {
    // Always roll into the "all" bucket
    applyProductToBucket(collections["all"], product);

    let handles = product.collection_handle;

    if (!handles) continue;

    if (typeof handles === "string") {
      try {
        handles = JSON.parse(handles);
      } catch {
        handles = [handles];
      }
    }

    if (!Array.isArray(handles)) continue;

    handles.forEach(handle => {

      if (!collections[handle]) {
        collections[handle] = {
          vendors: new Set(),
          productTypes: new Set(),
          colors: new Set(),
          fabrics: new Set(),
          delivery: new Set(),
          sizes: new Set(),
          prices: []
        };
      }

      applyProductToBucket(collections[handle], product);
    });
  }

  console.log(`Collections Found: ${Object.keys(collections).length} (including "all")`);

  const rows = Object.entries(collections).map(([handle, data]) => ({
    collection_handle: handle,
    filters: {
      vendors: [...data.vendors].sort().map(name => ({ name })),
      productTypes: [...data.productTypes].sort().map(name => ({ name })),
      colors: [...data.colors].sort().map(name => ({ name })),
      fabrics: [...data.fabrics].sort(),
      delivery_timeline: [...data.delivery].sort(),
      sizes: [...data.sizes].sort().map(name => ({
        name,
        available: true
      })),
      priceRange: {
        min: data.prices.length ? Math.min(...data.prices) : 0,
        max: data.prices.length ? Math.max(...data.prices) : 0
      }
    },
    updated_at: new Date().toISOString()
  }));

  // Upsert first, THEN delete stale rows that are no longer in `rows`.
  // Doing delete-then-upsert (the previous order) means any request that
  // lands in the gap between the two — or any failure partway through —
  // sees a filter_cache with rows missing entirely rather than just stale.
  const { error: cacheError } = await supabase
    .from("filter_cache")
    .upsert(rows, {
      onConflict: "collection_handle"
    });

  if (cacheError) throw cacheError;

  const currentHandles = rows.map(r => r.collection_handle);

  const { error: deleteError } = await supabase
    .from("filter_cache")
    .delete()
    .not("collection_handle", "in", `(${currentHandles.map(h => `"${h}"`).join(",")})`);

  if (deleteError) {
    // Stale-row cleanup failing is a non-fatal cosmetic issue (an old
    // collection's filters lingering) — don't let it fail the whole run.
    console.error("Filter cache stale-row cleanup failed (non-fatal):", deleteError);
  }

  console.log(`✅ Filter cache updated (${rows.length} collections)`);

  return rows.length;
}

/* =========================================================
   SCHEDULER — runs immediately, then every 2 hours
========================================================= */

const SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const syncHistory = []; // keeps the last 2 runs: { startedAt, finishedAt, success, totalSynced, error }

function formatTime(date) {
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

function logSyncHistory() {
  console.log("\n🕒 Sync History (last 2 runs):");
  if (syncHistory.length === 0) {
    console.log("  (none yet)");
  } else {
    syncHistory.forEach((run, i) => {
      const status = run.success ? "✅ success" : "❌ failed";
      console.log(
        `  ${i + 1}. ${formatTime(run.startedAt)} → ${formatTime(run.finishedAt)} | ${status}` +
          (run.success ? ` | ${run.totalSynced} products` : ` | ${run.error}`)
      );
    });
  }
  console.log(`⏭  Next sync scheduled: ${formatTime(new Date(Date.now() + SYNC_INTERVAL_MS))}\n`);
}

async function runScheduledSync() {
  const startedAt = new Date();

  const result = await syncProducts();

  const finishedAt = new Date();

  syncHistory.push({
    startedAt,
    finishedAt,
    success: result.success,
    totalSynced: result.totalSynced,
    error: result.error
  });

  // Keep only the last 2 runs
  if (syncHistory.length > 2) {
    syncHistory.shift();
  }

  logSyncHistory();
}

async function startScheduler() {
  console.log(`⏱  Scheduler started — syncing every 2 hours.\n`);

  // Run immediately on startup
  await runScheduledSync();

  // Then run every 2 hours
  setInterval(runScheduledSync, SYNC_INTERVAL_MS);
}

startScheduler();