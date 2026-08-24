import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   CONFIG
========================================================= */
const PAGE_SIZE = 250;
const SHOP =
  process.env.SHOPIFY_STORE ||
  "the-sverve.myshopify.com";

let TOKEN = null;
let TOKEN_EXPIRES = 0;

async function getAccessToken() {
  if (TOKEN && Date.now() < TOKEN_EXPIRES - 60000) {
    return TOKEN;
  }

  // Try cached token from Supabase
  const { data } = await supabase
    .from("shopify_config")
    .select("access_token, expires_at")
    .eq("id", 1)
    .single();

  if (
    data?.access_token &&
    data?.expires_at &&
    new Date(data.expires_at).getTime() > Date.now() + 60000
  ) {
    TOKEN = data.access_token;
    TOKEN_EXPIRES = new Date(data.expires_at).getTime();
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
  TOKEN_EXPIRES =
    Date.now() + tokenData.expires_in * 1000;
await supabase
  .from("filter_cache")
  .delete()
  .neq("collection_handle", "");

  await supabase
  .from("filter_cache")
  .upsert(rows, {
    onConflict: "collection_handle"
  });
  
  await supabase
    .from("shopify_config")
    .upsert({
      id: 1,
      access_token: TOKEN,
      expires_at: new Date(TOKEN_EXPIRES).toISOString(),
      updated_at: new Date().toISOString()
    });

  return TOKEN;
}

const API_VERSION =
  process.env.SHOPIFY_API_VERSION ||
  "2026-07";

const supabase = createClient(
  process.env.SUPABASE_URL || "https://rflabvnooobawvhxkuoi.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5"
);

if (!SHOP) {
  throw new Error("Missing Shopify credentials.");
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
       variants(first:250) {
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
   SYNC
========================================================= */

async function syncProducts() {

  try {

    console.log("================================");
    console.log("Starting Shopify Sync...");
    console.log("================================");

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

console.log(
  node.title,
  JSON.stringify(node.variants.edges[0]?.node?.selectedOptions, null, 2)
);

      variants.forEach((variant) => {
  if (variant.color) {
    colors.add(variant.color.trim());
  }
});

const tagColor = extractTag(tags, "Color");
if (tagColor) {
  colors.add(tagColor);
}
      const collectionHandles =
  node.collections?.edges?.map(c => c.node.handle) || [];
if (!collectionHandles.length) {
    console.warn(
        "No collections:",
        node.title,
        node.handle
    );
}
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

published: true,

status: "ACTIVE",



        compare_at_price:
          Number.parseFloat(
            node.variants?.edges?.[0]?.node?.compareAtPrice || 0
          ),

        image: getFirstImage(node.images),

       images: JSON.stringify(getAllImages(node.images)),

       color: JSON.stringify([...colors]),
if (!colors.size) {
    console.warn(
        "No colors:",
        node.title
    );
},
        size: extractTag(tags, "Size"),

        fabric: extractTag(tags, "Fabric"),

        delivery_timeline: extractTag(tags, "Delivery"),
        
      };

    });

    console.log(
      `Prepared ${products.length} products`
    );    let retries = 3;

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
// console.log(
//   `${Math.round((totalSynced / totalProducts) * 100)}% Complete`
// );
    console.log(
      "--------------------------------"
    );

    batch++;
      } // End while
      await buildFilterCache();
 console.log("\n================================");
    console.log("✅ Shopify Sync Completed");
    console.log(`📦 Total Products Synced: ${totalSynced}`);
    console.log("================================\n");

  } catch (error) {

    console.error("\n================================");
    console.error("❌ Shopify Sync Failed");
    console.error("================================");

    console.error(error);

    process.exitCode = 1;
  }
}
/* =========================================================
   BUILD FILTER CACHE
========================================================= */

async function buildFilterCache() {
  console.log("\nBuilding Filter Cache...");

  const { data: products, error } = await supabase
    .from("products")
    .select(`
title,
collection_handle,
vendor,
product_type,
color,
fabric,
delivery_time,
price,
variants
`)
  if (error) throw error;

  const collections = {};

  for (const product of products) {
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

      const c = collections[handle];

      if (product.vendor)
        c.vendors.add(product.vendor.trim());

      if (product.product_type)
        c.productTypes.add(product.product_type.trim());

      if (product.price)
        c.prices.push(Number(product.price));

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

      addValues(product.color, c.colors);
      console.log(
  "Product:",
  product.title,
  "Stored color:",
  product.color,
  "Parsed:",
  (() => {
    try {
      return JSON.parse(product.color);
    } catch {
      return product.color;
    }
  })()
);
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

    });
  }

  console.log(
    `Collections Found: ${Object.keys(collections).length}`
  );

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

const { error: cacheError } = await supabase
  .from("filter_cache")
  .upsert(rows, {
    onConflict: "collection_handle"
  });

if (cacheError) throw cacheError;

console.log(`✅ Filter cache updated (${rows.length} collections)`);
console.log(rows.slice(0,3));

return rows.length;
}

/* =========================================================
   START
========================================================= */

syncProducts()
  .then(() => {
    console.log("Done.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });