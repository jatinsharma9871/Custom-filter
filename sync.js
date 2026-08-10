import { createClient } from "@supabase/supabase-js";

// Node.js 18+ includes fetch, so node-fetch is not required.
const SHOP = "the-sverve.myshopify.com";
const CLIENT_ID ="53dfed9eb56ffec51c0f8e66178afb55";
const CLIENT_SECRET = "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";

const SUPABASE_URL = "https://rflabvnooobawvhxkuoi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5";
const SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5";
/* =========================================================
   CONFIG
========================================================= */

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

if (
  !SHOP ||
  !CLIENT_ID ||
  !CLIENT_SECRET ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error("Missing environment variables.");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/* =========================================================
   GENERATE SHOPIFY TOKEN
========================================================= */

async function generateShopifyToken() {
  const response = await fetch(
    `https://${SHOP}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  const responseText = await response.text();

let data;

try {
  data = JSON.parse(responseText);
} catch {
  throw new Error(
    `Invalid Shopify response: ${responseText}`
  );
}

  if (!response.ok) {
    throw new Error(
      `Token Error: ${JSON.stringify(data)}`
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/* =========================================================
   GET TOKEN FROM SUPABASE
========================================================= */

async function getShopifyAccessToken(forceRefresh = false) {
  if (!forceRefresh) {
    const { data: tokenRow } = await supabase
      .from("shopify_token")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

    if (
      tokenRow &&
      tokenRow.access_token &&
      tokenRow.expires_at &&
      new Date(tokenRow.expires_at).getTime() >
        Date.now() + 5 * 60 * 1000
    ) {
      console.log("✅ Using cached token");
      return tokenRow.access_token;
    }
  }

  console.log("🔄 Generating new Shopify token...");

  const token = await generateShopifyToken();

  const expiresAt = new Date(
    Date.now() +
      (token.expiresIn - 300) * 1000
  ).toISOString();

  const { error } = await supabase
    .from("shopify_token")
    .upsert(
      {
        id: 1,
        access_token: token.accessToken,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "id",
      }
    );

  if (error) throw error;

  console.log("✅ New token stored");

  return token.accessToken;
}

/* =========================================================
   HELPERS
========================================================= */

function extractTag(tags, prefix) {
  const tag = tags.find((value) =>
    value
      .toLowerCase()
      .startsWith(`${prefix.toLowerCase()}_`)
  );

  if (!tag) return null;

  return tag.substring(prefix.length + 1);
}
async function syncProducts() {
  try {
    console.log("Starting Shopify Sync...\n");

    let accessToken = await getShopifyAccessToken();

    let hasNextPage = true;
    let cursor = null;
    let totalSynced = 0;

    while (hasNextPage) {

      const query = `
      query GetProducts($cursor: String) {
        products(first: 250, after: $cursor) {
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

              images(first: 1) {
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
                  }
                }
              }
            }
          }
        }
      }
      `;

      let response = await fetch(
        `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            variables: {
              cursor,
            },
          }),
        }
      );

      // Refresh token automatically if expired
      if (response.status === 401) {

        console.log("Access token expired.");
        console.log("Refreshing...");

        accessToken = await getShopifyAccessToken(true);

        response = await fetch(
          `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: {
              "X-Shopify-Access-Token": accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query,
              variables: {
                cursor,
              },
            }),
          }
        );
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          `Shopify Error ${response.status}\n${JSON.stringify(data)}`
        );
      }

      if (data.errors) {
        throw new Error(JSON.stringify(data.errors));
      }

      const productConnection = data.data.products;
            if (!productConnection) {
        throw new Error(
          `Unexpected Shopify response:\n${JSON.stringify(data)}`
        );
      }

      const products = productConnection.edges.map(({ node }) => {
        const tags = node.tags || [];

        return {
          id: node.id,
          title: node.title,
          handle: node.handle,
          vendor: node.vendor,
          product_type: node.productType,

          price: Number.parseFloat(
            node.variants?.edges?.[0]?.node?.price || "0"
          ),

          image:
            node.images?.edges?.[0]?.node?.url || null,

          color: extractTag(tags, "Color"),
          size: extractTag(tags, "Size"),
          fabric: extractTag(tags, "Fabric"),
          delivery_time: extractTag(tags, "Delivery"),
        };
      });

      if (products.length) {

        const { error } = await supabase
          .from("products")
          .upsert(products, {
            onConflict: "id",
          });

        if (error) {
          throw error;
        }

        totalSynced += products.length;

        console.log(
          `✓ ${products.length} synced (Total: ${totalSynced})`
        );
      }

      hasNextPage =
        productConnection.pageInfo.hasNextPage;

      cursor =
        productConnection.pageInfo.endCursor;

    } console.log("\n========================================");
console.log("✅ Shopify Sync Completed Successfully");
console.log(`📦 Total Products Synced: ${totalSynced}`);
console.log("========================================\n");

} catch (error) {
  console.error("❌ Shopify Sync Failed");
  console.error(error);
  process.exitCode = 1;
}
}
syncProducts();