import { createClient } from "@supabase/supabase-js";

// Node.js 18+ includes fetch, so node-fetch is not required.
const SHOP = "the-sverve.myshopify.com";
const CLIENT_ID ="53dfed9eb56ffec51c0f8e66178afb55";
const CLIENT_SECRET = "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";

const SUPABASE_URL = "https://rflabvnooobawvhxkuoi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5";

const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

if (
  !SHOP ||
  !CLIENT_ID ||
  !CLIENT_SECRET ||
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY
) {
  throw new Error(
    "Missing required environment variables. Check your .env file."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function generateShopifyToken() {
  const response = await fetch(
    `https://${SHOP}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
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
      `Shopify token response was not valid JSON: ${responseText}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify token error ${response.status}: ${
        data.error_description ||
        data.error ||
        JSON.stringify(data)
      }`
    );
  }

  if (!data.access_token) {
    throw new Error(
      `Shopify token missing from response: ${JSON.stringify(data)}`
    );
  }

  return data.access_token;
}

function extractTag(tags, prefix) {
  const tag = tags.find((value) =>
    value.toLowerCase().startsWith(`${prefix.toLowerCase()}_`)
  );

  if (!tag) {
    return null;
  }

  // Supports values such as "Color_Dark Green"
  return tag.substring(prefix.length + 1);
}

async function syncProducts() {
  try {
    // const accessToken = await getShopifyAccessToken();
    // =========================================================
// GET TOKEN FROM SUPABASE (AUTO REFRESH)
// =========================================================

  // Read saved token
  const { data: tokenRow, error } = await supabase
    .from("shopify_token")
    .select("*")
    .eq("id", 1)
    .single();

  if (error && error.code !== "PGRST116") {
    throw error;
  }

  const now = Date.now();

  // Return existing token if still valid
  if (
    tokenRow &&
    tokenRow.access_token &&
    tokenRow.expires_at &&
    new Date(tokenRow.expires_at).getTime() > now + 5 * 60 * 1000
  ) {
    console.log("Using cached Shopify token");
    return tokenRow.access_token;
  }

  console.log("Generating new Shopify token...");

  const response = await fetch(
    `https://${SHOP}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  const expiresAt = new Date(
    Date.now() + (data.expires_in - 300) * 1000
  ).toISOString();

  await supabase
    .from("shopify_token")
    .upsert(
      {
        id: 1,
        access_token: data.access_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "id",
      }
    );

  console.log("New Shopify token saved.");

  return data.access_token;
}

    console.log("Starting product sync...\n");

    let hasNextPage = true;
    let cursor = null;
    let totalSynced = 0;

    while (hasNextPage) {
      const accessToken = await getShopifyAccessToken();
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

      const response = await fetch(
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

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          `Shopify API error ${response.status}: ${JSON.stringify(data)}`
        );
      }

      if (data.errors) {
        throw new Error(
          `Shopify GraphQL error: ${JSON.stringify(data.errors)}`
        );
      }

      const productConnection = data?.data?.products;

      if (!productConnection) {
        throw new Error(
          `Unexpected Shopify response: ${JSON.stringify(data)}`
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
          image: node.images?.edges?.[0]?.node?.url || null,
          color: extractTag(tags, "Color"),
          size: extractTag(tags, "Size"),
          fabric: extractTag(tags, "Fabric"),
          delivery_time: extractTag(tags, "Delivery"),
          product_type: node.productType,
        };
      });

      if (products.length > 0) {
        const { error } = await supabase
          .from("products")
          .upsert(products, {
            onConflict: "id",
          });

        if (error) {
          throw new Error(`Supabase upsert error: ${error.message}`);
        }

        totalSynced += products.length;

        console.log(
          `✓ Synced ${products.length} products ` +
          `(Total: ${totalSynced})`
        );
      }

      hasNextPage = productConnection.pageInfo.hasNextPage;
      cursor = productConnection.pageInfo.endCursor;
    }

    console.log(`\n✅ All products synced! Total: ${totalSynced}`);
  } catch (error) {
    console.error("❌ Sync failed:", error.message);
    process.exitCode = 1;
  }
}

syncProducts();