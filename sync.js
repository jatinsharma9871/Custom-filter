import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   CONFIG
========================================================= */
const PAGE_SIZE = 250;
const SHOP =
  process.env.SHOPIFY_STORE ||
  "the-sverve.myshopify.com";

const TOKEN =
  process.env.SHOPIFY_ACCESS_TOKEN ||
  "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";

const API_VERSION =
  process.env.SHOPIFY_API_VERSION ||
  "2026-07";

const supabase = createClient(
  process.env.SUPABASE_URL || "https://rflabvnooobawvhxkuoi.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5"
);

if (!SHOP || !TOKEN) {
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

  const response = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": TOKEN,
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

        variants(first: 1) {
          edges {
            node {
              price
              compareAtPrice
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

      return {
        id: node.id,

        title: node.title,

        handle: node.handle,

        vendor: node.vendor,

        product_type: node.productType,

        collection: node.productType,

        price: getPrice(node.variants),

        compare_at_price:
          Number.parseFloat(
            node.variants?.edges?.[0]?.node?.compareAtPrice || 0
          ),

        image: getFirstImage(node.images),

       images: JSON.stringify(getAllImages(node.images)),

        color: extractTag(tags, "Color"),

        size: extractTag(tags, "Size"),

        fabric: extractTag(tags, "Fabric"),

        delivery_time: extractTag(tags, "Delivery"),
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
console.log(
  `${Math.round((totalSynced / totalProducts) * 100)}% Complete`
);
    console.log(
      "--------------------------------"
    );

    batch++;
      } // End while
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