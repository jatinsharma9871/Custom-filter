import { createClient } from "@supabase/supabase-js";

/* =========================================================
   CONFIG
========================================================= */

export const config = {
  maxDuration: 300
};

const API_VERSION = "2026-07";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


/* =========================================================
   LOGGING
========================================================= */

function logSyncStatus(status, details = {}) {
  console.log(
    JSON.stringify({
      service: "shopify-sync",
      status,
      at: new Date().toISOString(),
      ...details
    })
  );
}


/* =========================================================
   ENVIRONMENT
========================================================= */

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`
    );
  }

  return value;
}

function validateEnvironment({ requireCronSecret = false } = {}) {
  requiredEnv("SHOPIFY_SHOP");
  requiredEnv("SHOPIFY_CLIENT_ID");
  requiredEnv("SHOPIFY_CLIENT_SECRET");
  requiredEnv("SUPABASE_URL");
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (requireCronSecret) {
    requiredEnv("CRON_SECRET");
  }
}


/* =========================================================
   ENV VALUES
========================================================= */

const SHOP = process.env.SHOPIFY_SHOP;

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;

const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;


/* =========================================================
   SUPABASE
========================================================= */

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);


/* =========================================================
   SHOPIFY TOKEN CACHE
========================================================= */

let inMemoryToken = null;


/* =========================================================
   CHECK TOKEN
========================================================= */

function tokenIsUsable(token) {
  if (!token?.access_token || !token?.expires_at) {
    return false;
  }

  const expiryTime =
    new Date(token.expires_at).getTime();

  return (
    expiryTime >
    Date.now() + TOKEN_REFRESH_BUFFER_MS
  );
}


/* =========================================================
   REQUEST NEW SHOPIFY ACCESS TOKEN
========================================================= */

async function requestNewAccessToken() {
  logSyncStatus("REFRESHING_ACCESS_TOKEN");

  const shop = requiredEnv("SHOPIFY_SHOP");
  const clientId = requiredEnv("SHOPIFY_CLIENT_ID");
  const clientSecret =
    requiredEnv("SHOPIFY_CLIENT_SECRET");

  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const payload =
    await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Shopify token request failed: ${
        payload.error_description ||
        payload.error ||
        response.status
      }`
    );
  }

  const expiresIn =
    Number(payload.expires_in || 86399);

  const expiresAt =
    new Date(
      Date.now() + expiresIn * 1000
    ).toISOString();

  const token = {
    shop,
    access_token: payload.access_token,
    expires_at: expiresAt,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("shopify_access_tokens")
    .upsert(token, {
      onConflict: "shop"
    });

  if (error) {
    throw new Error(
      `Unable to save Shopify token: ${error.message}`
    );
  }

  inMemoryToken = token;

  logSyncStatus(
    "ACCESS_TOKEN_REFRESHED",
    {
      expiresAt
    }
  );

  return token.access_token;
}


/* =========================================================
   GET SHOPIFY ACCESS TOKEN
========================================================= */

async function getShopifyAccessToken(
  { forceRefresh = false } = {}
) {
  const shop = requiredEnv("SHOPIFY_SHOP");

  /*
   * First check memory cache.
   */

  if (
    !forceRefresh &&
    tokenIsUsable(inMemoryToken)
  ) {
    return inMemoryToken.access_token;
  }


  /*
   * Then check Supabase cache.
   */

  if (!forceRefresh) {
    const { data, error } =
      await supabase
        .from("shopify_access_tokens")
        .select(
          "shop, access_token, expires_at"
        )
        .eq("shop", shop)
        .maybeSingle();

    if (error) {
      throw new Error(
        `Unable to read Shopify token: ${error.message}`
      );
    }

    if (tokenIsUsable(data)) {
      inMemoryToken = data;

      logSyncStatus(
        "USING_CACHED_ACCESS_TOKEN"
      );

      return data.access_token;
    }
  }


  /*
   * Token missing/expired.
   */

  return requestNewAccessToken();
}


/* =========================================================
   SHOPIFY REQUEST
========================================================= */

async function shopifyRequest(
  url,
  options = {},
  retryAfterRefresh = true
) {
  const send = async (forceRefresh) => {
    const token =
      await getShopifyAccessToken({
        forceRefresh
      });

    return fetch(url, {
      ...options,

      headers: {
        ...options.headers,
        "X-Shopify-Access-Token":
          token
      }
    });
  };


  /*
   * First attempt
   */

  let response =
    await send(false);


  /*
   * If Shopify says unauthorized,
   * refresh token once.
   */

  if (
    response.status === 401 &&
    retryAfterRefresh
  ) {
    logSyncStatus(
      "SHOPIFY_401_REFRESHING_TOKEN"
    );

    response =
      await send(true);
  }

  return response;
}


/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

async function shopifyGraphQL(query) {
  const shop =
    requiredEnv("SHOPIFY_SHOP");

  const response =
    await shopifyRequest(
      `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          query
        })
      }
    );

  const payload =
    await response.json().catch(() => ({}));

  if (
    !response.ok ||
    payload.errors
  ) {
    throw new Error(
      `Shopify GraphQL request failed: ${JSON.stringify(
        payload.errors ||
        payload
      )}`
    );
  }

  return payload.data;
}


/* =========================================================
   SHOPIFY REST GET
========================================================= */

async function shopifyRestGet(url) {
  const response =
    await shopifyRequest(
      url,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

  const payload =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Shopify REST request failed: ${
        typeof payload.errors === "string"
          ? payload.errors
          : JSON.stringify(
              payload.errors || payload
            )
      }`
    );
  }

  return {
    payload,
    link:
      response.headers.get("link")
  };
}


/* =========================================================
   FETCH COLLECTION POSITIONS
========================================================= */

async function fetchAllCollects(
  collectionIds
) {
  const shop =
    requiredEnv("SHOPIFY_SHOP");

  const result = {};

  let collectionNumber = 0;

  for (
    const collectionId
    of collectionIds
  ) {
    collectionNumber++;

    result[collectionId] = {};

    logSyncStatus(
      "FETCHING_COLLECTION_POSITIONS",
      {
        collection:
          collectionNumber,
        totalCollections:
          collectionIds.length,
        collectionId
      }
    );

    let url =
      `https://${shop}/admin/api/${API_VERSION}/collects.json` +
      `?collection_id=${collectionId}&limit=250`;

    while (url) {
      const {
        payload,
        link
      } =
        await shopifyRestGet(url);

      for (
        const collect
        of payload.collects || []
      ) {
        result[collectionId][
          collect.product_id
        ] =
          collect.position;
      }

      url =
        link?.match(
          /<([^>]+)>; rel="next"/
        )?.[1] || null;
    }

    await sleep(150);
  }

  return result;
}


/* =========================================================
   FETCH BEST SELLING RANK
========================================================= */

async function fetchBestSelling() {
  const collectionId =
    process.env
      .SHOPIFY_BEST_SELLING_COLLECTION_ID;

  if (!collectionId) {
    logSyncStatus(
      "BEST_SELLING_COLLECTION_NOT_SET"
    );

    return {};
  }

  const ranks = {};

  let cursor = null;

  let hasNextPage = true;

  let rank = 1;

  let page = 0;

  while (hasNextPage) {
    page++;

    const data =
      await shopifyGraphQL(`
        {
          collection(
            id: "${collectionId}"
          ) {
            products(
              first: 250,
              sortKey: BEST_SELLING
              ${
                cursor
                  ? `, after: "${cursor}"`
                  : ""
              }
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }

              edges {
                node {
                  id
                }
              }
            }
          }
        }
      `);

    const products =
      data.collection?.products;

    if (!products) {
      break;
    }

    for (
      const edge
      of products.edges
    ) {
      const productId =
        edge.node.id
          .split("/")
          .pop();

      ranks[productId] =
        rank++;
    }

    logSyncStatus(
      "BEST_SELLING_PAGE_FETCHED",
      {
        page,
        products:
          products.edges.length
      }
    );

    hasNextPage =
      products.pageInfo.hasNextPage;

    cursor =
      products.pageInfo.endCursor;

    await sleep(150);
  }

  return ranks;
}


/* =========================================================
   OPTION VALUE
========================================================= */

function optionValue(
  selectedOptions,
  names
) {
  const option =
    selectedOptions.find(
      (item) =>
        names.includes(
          String(
            item.name || ""
          )
            .trim()
            .toLowerCase()
        )
    );

  return option?.value || null;
}


/* =========================================================
   STANDARDIZE COLOR
========================================================= */

function standardizeColorLabel(
  value
) {
  const label =
    String(value || "").trim();

  const comparable =
    label
      .toLowerCase()
      .replace(
        /[\s_-]/g,
        ""
      );

  if (
    [
      "multi",
      "multicolor",
      "multicolour"
    ].includes(comparable)
  ) {
    return "Multicolour";
  }

  return label || null;
}


/* =========================================================
   METAOBJECT COLORS
========================================================= */

function getMetaobjectColors(
  metafields
) {
  const metaobjects =
    metafields.flatMap(
      ({
        node: metafield
      }) => [
        metafield.reference,

        ...(
          metafield.references
            ?.edges || []
        ).map(
          ({ node }) =>
            node
        )
      ]
    );

  return [
    ...new Set(
      metaobjects
        .filter(
          (metaobject) =>
            metaobject?.type ===
            "shopify--color-pattern"
        )
        .map(
          (metaobject) =>
            standardizeColorLabel(
              metaobject.displayName
            )
        )
        .filter(Boolean)
    )
  ];
}


/* =========================================================
   SYNC PRODUCTS
========================================================= */

export async function syncProducts() {
  validateEnvironment();

  const allProducts = [];

  const collectionIds =
    new Set();

  let cursor = null;

  let hasNextPage = true;

  let page = 0;


  /* ---------------------------------------------------------
     FETCH PRODUCTS
  --------------------------------------------------------- */

  logSyncStatus(
    "FETCHING_PRODUCTS"
  );

  while (hasNextPage) {
    page++;

    const data =
      await shopifyGraphQL(`
        {
          products(
            first: 250
            ${
              cursor
                ? `, after: "${cursor}"`
                : ""
            }
          ) {
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
                createdAt
                publishedAt

                metafields(
                  first: 50
                ) {
                  edges {
                    node {
                      namespace
                      key
                      type
                      value

                      reference {
                        ... on Metaobject {
                          type
                          displayName

                          fields {
                            key
                            value
                          }
                        }
                      }

                      references(
                        first: 50
                      ) {
                        edges {
                          node {
                            ... on Metaobject {
                              type
                              displayName

                              fields {
                                key
                                value
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }

                collections(
                  first: 250
                ) {
                  edges {
                    node {
                      id
                      handle
                    }
                  }
                }

                images(
                  first: 2
                ) {
                  edges {
                    node {
                      url
                    }
                  }
                }

                variants(
                  first: 250
                ) {
                  edges {
                    node {
                      id
                      price
                      inventoryQuantity

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
      `);

    const products =
      data.products;

    for (
      const edge
      of products.edges
    ) {
      const node =
        edge.node;

      const collections =
        node.collections.edges.map(
          ({
            node: collection
          }) => {
            const id =
              collection.id
                .split("/")
                .pop();

            collectionIds.add(id);

            return {
              id,
              handle:
                collection.handle
            };
          }
        );

      allProducts.push({
        node,
        collections
      });
    }

    logSyncStatus(
      "PRODUCT_PAGE_FETCHED",
      {
        page,

        productsOnPage:
          products.edges.length,

        totalProductsFetched:
          allProducts.length
      }
    );

    hasNextPage =
      products.pageInfo.hasNextPage;

    cursor =
      products.pageInfo.endCursor;

    await sleep(200);
  }


  /* ---------------------------------------------------------
     FETCH COLLECTION POSITIONS + BEST SELLING
  --------------------------------------------------------- */

  const [
    collectsMap,
    bestSellingMap
  ] =
    await Promise.all([
      fetchAllCollects(
        [...collectionIds]
      ),

      fetchBestSelling()
    ]);


  /* ---------------------------------------------------------
     PROCESS PRODUCTS
  --------------------------------------------------------- */

  logSyncStatus(
    "PROCESSING_PRODUCTS",
    {
      products:
        allProducts.length,

      collections:
        collectionIds.size
    }
  );


  const rows =
    allProducts.map(
      ({
        node,
        collections
      }) => {

        const productId =
          node.id
            .split("/")
            .pop();


        /* COLLECTION POSITION */

        const positions =
          collections
            .map(
              (collection) =>
                collectsMap[
                  collection.id
                ]?.[
                  productId
                ]
            )
            .filter(
              (position) =>
                Number.isFinite(
                  position
                )
            );


        /* VARIANTS */

        const variants =
          node.variants.edges.map(
            ({
              node: variant
            }) => {

              const selectedOptions =
                variant.selectedOptions ||
                [];

              const inventoryQuantity =
                Number(
                  variant.inventoryQuantity ||
                  0
                );

              return {
                id:
                  variant.id
                    .split("/")
                    .pop(),

                price:
                  Number(
                    variant.price ||
                    0
                  ),

                inventory_quantity:
                  inventoryQuantity,

                available:
                  inventoryQuantity >
                  0,

                size:
                  optionValue(
                    selectedOptions,
                    ["size"]
                  ),

                color:
                  optionValue(
                    selectedOptions,
                    [
                      "color",
                      "colour"
                    ]
                  )
              };
            }
          );


        /* COLORS */

        const variantColors = [
          ...new Set(
            variants
              .map(
                (variant) =>
                  standardizeColorLabel(
                    variant.color
                  )
              )
              .filter(Boolean)
          )
        ];


        /* INVENTORY */

        const inventoryQuantity =
          variants.reduce(
            (
              sum,
              variant
            ) =>
              sum +
              variant.inventory_quantity,
            0
          );


        /* METAFIELDS */

        const metafields =
          node.metafields
            ?.edges || [];


        /* METAOBJECT COLORS */

        const metaobjectColors =
          getMetaobjectColors(
            metafields
          );


        /* DELIVERY TIME */

        const deliveryTimeline =
          metafields.find(
            ({
              node: metafield
            }) =>
              metafield.namespace ===
                "custom" &&
              metafield.key ===
                "delivery_time"
          )?.node.value ||
          null;


        /* PRICE */

        const prices =
          variants
            .map(
              (variant) =>
                variant.price
            )
            .filter(
              (price) =>
                Number.isFinite(
                  price
                )
            );

        const minimumPrice =
          prices.length
            ? Math.min(
                ...prices
              )
            : 0;


        /* IMAGES */

        const images =
          node.images.edges.map(
            ({
              node: image
            }) =>
              image.url
          );


        /* FINAL ROW */

        return {
          id:
            productId,

          title:
            node.title,

          handle:
            node.handle,

          vendor:
            node.vendor,

          product_type:
            node.productType,

          collection_handle:
            collections.map(
              (collection) =>
                collection.handle
            ),

          position:
            positions.length
              ? Math.min(
                  ...positions
                )
              : 9999,

          best_selling_rank:
            bestSellingMap[
              productId
            ] ?? 9999,

          price:
            minimumPrice,

          images,

          image:
            images[0] ||
            null,

          image2:
            images[1] ||
            null,

          color:
            metaobjectColors.length
              ? metaobjectColors
              : variantColors,

          variants,

          inventory_quantity:
            inventoryQuantity,

          status:
            node.status,

          published:
            node.status ===
              "ACTIVE" &&
            Boolean(
              node.publishedAt
            ),

          delivery_timeline:
            deliveryTimeline,

          created_at:
            node.createdAt,

          published_at:
            node.publishedAt
        };
      }
    );


  /* ---------------------------------------------------------
     UPLOAD TO SUPABASE
  --------------------------------------------------------- */

  const BATCH_SIZE = 500;

  for (
    let index = 0;
    index < rows.length;
    index += BATCH_SIZE
  ) {
    const batchNumber =
      Math.floor(
        index /
        BATCH_SIZE
      ) + 1;

    const batch =
      rows.slice(
        index,
        index +
          BATCH_SIZE
      );

    logSyncStatus(
      "UPLOADING_BATCH",
      {
        batch:
          batchNumber,

        batchSize:
          batch.length
      }
    );

    const { error } =
      await supabase
        .from("products")
        .upsert(
          batch,
          {
            onConflict:
              "id"
          }
        );

    if (error) {
      throw new Error(
        `Supabase upsert failed: ${error.message}`
      );
    }
  }


  /* ---------------------------------------------------------
     COMPLETE
  --------------------------------------------------------- */

  const lastUpdatedAt =
    new Date().toISOString();

  logSyncStatus(
    "SYNC_COMPLETED",
    {
      syncedProducts:
        rows.length,

      lastUpdatedAt
    }
  );

  return {
    syncedProducts:
      rows.length,

    lastUpdatedAt
  };
}


/* =========================================================
   VERCEL API HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {
  try {

    validateEnvironment({
      requireCronSecret: true
    });


    /* ONLY GET */

    if (
      req.method !== "GET"
    ) {
      return res
        .status(405)
        .json({
          error:
            "Method not allowed"
        });
    }


    /* CHECK CRON SECRET */

    if (
      req.headers.authorization !==
      `Bearer ${process.env.CRON_SECRET}`
    ) {
      return res
        .status(401)
        .json({
          error:
            "Unauthorized"
        });
    }


    /* START */

    logSyncStatus(
      "SYNC_STARTED",
      {
        trigger:
          "api"
      }
    );


    const result =
      await syncProducts();


    /* NO CACHE */

    res.setHeader(
      "Cache-Control",
      "no-store"
    );


    /* RESPONSE */

    return res
      .status(200)
      .json({
        ok: true,

        status:
          "SYNC_COMPLETED",

        ...result
      });

  } catch (error) {

    logSyncStatus(
      "SYNC_FAILED",
      {
        error:
          error.message
      }
    );

    console.error(
      "Shopify sync failed:",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,

        error:
          error.message
      });
  }
}


/* =========================================================
   MANUAL COMMAND LINE RUNNER

   Run:
   node sync.js --run
========================================================= */

async function runFromCommandLine() {
  try {

    console.log(
      "\n=========================================="
    );

    console.log(
      " Shopify → Supabase Sync"
    );

    console.log(
      "==========================================\n"
    );


    validateEnvironment();


    logSyncStatus(
      "SYNC_STARTED",
      {
        trigger:
          "command-line"
      }
    );


    const result =
      await syncProducts();


    console.log(
      "\n=========================================="
    );

    console.log(
      " SYNC COMPLETED"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Products synced: ${result.syncedProducts}`
    );

    console.log(
      `Last updated: ${result.lastUpdatedAt}`
    );

    console.log(
      "==========================================\n"
    );


    process.exit(0);

  } catch (error) {

    console.error(
      "\n=========================================="
    );

    console.error(
      " SYNC FAILED"
    );

    console.error(
      "=========================================="
    );

    console.error(
      error.message
    );

    console.error(
      "==========================================\n"
    );


    process.exit(1);
  }
}


/* =========================================================
   DETECT --run
========================================================= */

if (
  process.argv.includes(
    "--run"
  )
) {
  runFromCommandLine();
}