import { createClient } from "@supabase/supabase-js";

export const config = {
  maxDuration: 300
};

const API_VERSION = "2026-07";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

let inMemoryToken = null;

function tokenIsUsable(token) {
  return (
    token?.access_token &&
    new Date(token.expires_at).getTime() > Date.now() + TOKEN_REFRESH_BUFFER_MS
  );
}

async function requestNewAccessToken() {
  const response = await fetch(
    `https://${SHOP}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Shopify token request failed: ${payload.error_description || payload.error || response.status}`
    );
  }

  const expiresAt = new Date(
    Date.now() + Number(payload.expires_in || 86399) * 1000
  ).toISOString();

  const token = {
    shop: SHOP,
    access_token: payload.access_token,
    expires_at: expiresAt,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("shopify_access_tokens")
    .upsert(token, { onConflict: "shop" });

  if (error) {
    throw new Error(`Unable to save Shopify token: ${error.message}`);
  }

  inMemoryToken = token;
  return token.access_token;
}

async function getShopifyAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && tokenIsUsable(inMemoryToken)) {
    return inMemoryToken.access_token;
  }

  if (!forceRefresh) {
    const { data, error } = await supabase
      .from("shopify_access_tokens")
      .select("shop, access_token, expires_at")
      .eq("shop", SHOP)
      .maybeSingle();

    if (error) {
      throw new Error(`Unable to read Shopify token: ${error.message}`);
    }

    if (tokenIsUsable(data)) {
      inMemoryToken = data;
      return data.access_token;
    }
  }

  return requestNewAccessToken();
}

async function shopifyRequest(url, options = {}, retryAfterRefresh = true) {
  const send = async (forceRefresh) => {
    const token = await getShopifyAccessToken({ forceRefresh });

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        "X-Shopify-Access-Token": token
      }
    });
  };

  let response = await send(false);

  // A token revoked early or expired between requests is refreshed once.
  if (response.status === 401 && retryAfterRefresh) {
    response = await send(true);
  }

  return response;
}

async function shopifyGraphQL(query) {
  const response = await shopifyRequest(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.errors) {
    throw new Error(
      `Shopify GraphQL request failed: ${JSON.stringify(payload.errors || payload)}`
    );
  }

  return payload.data;
}

async function shopifyRestGet(url) {
  const response = await shopifyRequest(url, {
    headers: { Accept: "application/json" }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Shopify REST request failed: ${payload.errors || response.status}`
    );
  }

  return { payload, link: response.headers.get("link") };
}

async function fetchAllCollects(collectionIds) {
  const result = {};

  for (const collectionId of collectionIds) {
    result[collectionId] = {};
    let url = `https://${SHOP}/admin/api/${API_VERSION}/collects.json?collection_id=${collectionId}&limit=250`;

    while (url) {
      const { payload, link } = await shopifyRestGet(url);

      for (const collect of payload.collects || []) {
        result[collectionId][collect.product_id] = collect.position;
      }

      url = link?.match(/<([^>]+)>; rel="next"/)?.[1] || null;
    }

    await sleep(150);
  }

  return result;
}

async function fetchBestSelling() {
  const collectionId = process.env.SHOPIFY_BEST_SELLING_COLLECTION_ID;
  if (!collectionId) return {};

  const ranks = {};
  let cursor = null;
  let hasNextPage = true;
  let rank = 1;

  while (hasNextPage) {
    const data = await shopifyGraphQL(`
      {
        collection(id: "${collectionId}") {
          products(first: 250, sortKey: BEST_SELLING${cursor ? `, after: "${cursor}"` : ""}) {
            pageInfo { hasNextPage endCursor }
            edges { node { id } }
          }
        }
      }
    `);

    const products = data.collection?.products;
    if (!products) break;

    for (const edge of products.edges) {
      ranks[edge.node.id.split("/").pop()] = rank++;
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
    await sleep(150);
  }

  return ranks;
}

function optionValue(selectedOptions, names) {
  const option = selectedOptions.find((item) =>
    names.includes(String(item.name || "").trim().toLowerCase())
  );

  return option?.value || null;
}

async function syncProducts() {
  const allProducts = [];
  const collectionIds = new Set();
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(`
      {
        products(first: 250${cursor ? `, after: "${cursor}"` : ""}) {
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
                edges { node { key value namespace } }
              }
              collections(first: 250) {
                edges { node { id handle } }
              }
              images(first: 2) {
                edges { node { url } }
              }
              variants(first: 250) {
                edges {
                  node {
                    id
                    price
                    inventoryQuantity
                    selectedOptions { name value }
                  }
                }
              }
            }
          }
        }
      }
    `);

    const products = data.products;

    for (const edge of products.edges) {
      const node = edge.node;
      const collections = node.collections.edges.map(({ node: collection }) => {
        const id = collection.id.split("/").pop();
        collectionIds.add(id);
        return { id, handle: collection.handle };
      });

      allProducts.push({ node, collections });
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
    await sleep(200);
  }

  const [collectsMap, bestSellingMap] = await Promise.all([
    fetchAllCollects([...collectionIds]),
    fetchBestSelling()
  ]);

  const rows = allProducts.map(({ node, collections }) => {
    const productId = node.id.split("/").pop();
    const positions = collections
      .map((collection) => collectsMap[collection.id]?.[productId])
      .filter((position) => Number.isFinite(position));

    const variants = node.variants.edges.map(({ node: variant }) => {
      const selectedOptions = variant.selectedOptions || [];
      const inventoryQuantity = Number(variant.inventoryQuantity || 0);

      return {
        id: variant.id.split("/").pop(),
        price: Number(variant.price || 0),
        inventory_quantity: inventoryQuantity,
        // Inventory quantity is intentionally used to hide out-of-stock items.
        available: inventoryQuantity > 0,
        size: optionValue(selectedOptions, ["size"]),
        color: optionValue(selectedOptions, ["color", "colour"])
      };
    });

    const colors = [...new Set(variants.map((variant) => variant.color).filter(Boolean))];
    const inventoryQuantity = variants.reduce(
      (sum, variant) => sum + variant.inventory_quantity,
      0
    );
    const metafields = node.metafields?.edges || [];
    const deliveryTimeline = metafields.find(
      ({ node: metafield }) =>
        metafield.namespace === "custom" && metafield.key === "delivery_time"
    )?.node.value || null;

    return {
      id: productId,
      title: node.title,
      handle: node.handle,
      vendor: node.vendor,
      product_type: node.productType,
      collection_handle: collections.map((collection) => collection.handle),
      position: positions.length ? Math.min(...positions) : 9999,
      best_selling_rank: bestSellingMap[productId] ?? 9999,
      price: variants.length ? Math.min(...variants.map((variant) => variant.price)) : 0,
      images: node.images.edges.map(({ node: image }) => image.url),
      image: node.images.edges[0]?.node.url || null,
      image2: node.images.edges[1]?.node.url || null,
      color: colors,
      variants,
      inventory_quantity: inventoryQuantity,
      status: node.status,
      published: node.status === "ACTIVE" && Boolean(node.publishedAt),
      delivery_timeline: deliveryTimeline,
      created_at: node.createdAt,
      published_at: node.publishedAt
    };
  });

  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase
      .from("products")
      .upsert(rows.slice(index, index + 500), { onConflict: "id" });

    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  return rows.length;
}

export default async function handler(req, res) {
  try {
    requiredEnv("SHOPIFY_SHOP");
    requiredEnv("SHOPIFY_CLIENT_ID");
    requiredEnv("SHOPIFY_CLIENT_SECRET");
    requiredEnv("SUPABASE_URL");
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    requiredEnv("CRON_SECRET");

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const syncedProducts = await syncProducts();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      syncedProducts,
      completedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Shopify sync failed:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
