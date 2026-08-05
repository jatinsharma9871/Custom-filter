import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   CONFIG
========================================================= */

export const config = {
  maxDuration: 300
};

const API_VERSION = "2026-07";

const PRODUCT_PAGE_SIZE = 100;
const VARIANT_PAGE_SIZE = 100;
const METAFIELD_PAGE_SIZE = 50;
const REFERENCE_PAGE_SIZE = 100;
const SUPABASE_BATCH_SIZE = 250;

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

  if (!value || !String(value).trim()) {
    throw new Error(
      `Missing required environment variable: ${name}`
    );
  }

  return String(value).trim();
}


function validateEnvironment({
  requireCronSecret = false
} = {}) {
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
   SUPABASE
========================================================= */

let supabaseClient = null;


function getSupabase() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const url =
    requiredEnv("SUPABASE_URL");

  const key =
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  supabaseClient =
    createClient(
      url,
      key,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

  return supabaseClient;
}


/* =========================================================
   SHOPIFY TOKEN CACHE
========================================================= */

let inMemoryToken = null;


function tokenIsUsable(token) {
  if (
    !token?.access_token ||
    !token?.expires_at
  ) {
    return false;
  }

  const expiry =
    new Date(
      token.expires_at
    ).getTime();

  if (!Number.isFinite(expiry)) {
    return false;
  }

  return (
    expiry >
    Date.now() +
      TOKEN_REFRESH_BUFFER_MS
  );
}


/* =========================================================
   REQUEST NEW SHOPIFY ACCESS TOKEN
========================================================= */

async function requestNewAccessToken() {
  logSyncStatus(
    "REFRESHING_ACCESS_TOKEN"
  );

  const shop =
    requiredEnv("SHOPIFY_SHOP");

  const clientId =
    requiredEnv("SHOPIFY_CLIENT_ID");

  const clientSecret =
    requiredEnv("SHOPIFY_CLIENT_SECRET");

  const response =
    await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          new URLSearchParams({
            grant_type:
              "client_credentials",

            client_id:
              clientId,

            client_secret:
              clientSecret
          })
      }
    );

  const payload =
    await response
      .json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !payload.access_token
  ) {
    throw new Error(
      `Shopify token request failed: ${
        payload.error_description ||
        payload.error ||
        JSON.stringify(payload) ||
        response.status
      }`
    );
  }

  const expiresIn =
    Number(
      payload.expires_in ||
      86399
    );

  const expiresAt =
    new Date(
      Date.now() +
        expiresIn * 1000
    ).toISOString();

  const token = {
    shop,

    access_token:
      payload.access_token,

    expires_at:
      expiresAt,

    updated_at:
      new Date().toISOString()
  };

  const supabase =
    getSupabase();

  const { error } =
    await supabase
      .from(
        "shopify_access_tokens"
      )
      .upsert(
        token,
        {
          onConflict:
            "shop"
        }
      );

  if (error) {
    throw new Error(
      `Unable to save Shopify token: ${error.message}`
    );
  }

  inMemoryToken =
    token;

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

async function getShopifyAccessToken({
  forceRefresh = false
} = {}) {
  const shop =
    requiredEnv("SHOPIFY_SHOP");

  if (
    !forceRefresh &&
    tokenIsUsable(
      inMemoryToken
    )
  ) {
    return (
      inMemoryToken
        .access_token
    );
  }

  if (!forceRefresh) {
    const supabase =
      getSupabase();

    const {
      data,
      error
    } =
      await supabase
        .from(
          "shopify_access_tokens"
        )
        .select(
          "shop, access_token, expires_at"
        )
        .eq(
          "shop",
          shop
        )
        .maybeSingle();

    if (error) {
      throw new Error(
        `Unable to read Shopify token: ${error.message}`
      );
    }

    if (
      tokenIsUsable(data)
    ) {
      inMemoryToken =
        data;

      logSyncStatus(
        "USING_CACHED_ACCESS_TOKEN"
      );

      return (
        data.access_token
      );
    }
  }

  return requestNewAccessToken();
}


/* =========================================================
   SHOPIFY REQUEST
========================================================= */

async function shopifyRequest(
  url,
  options = {}
) {
  const send =
    async (
      forceRefresh
    ) => {

      const token =
        await getShopifyAccessToken({
          forceRefresh
        });

      return fetch(
        url,
        {
          ...options,

          headers: {
            ...(options.headers ||
              {}),

            "X-Shopify-Access-Token":
              token
          }
        }
      );
    };

  let response =
    await send(false);

  if (
    response.status === 401
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
   GRAPHQL
========================================================= */

async function shopifyGraphQL(
  query,
  variables = {}
) {
  const shop =
    requiredEnv("SHOPIFY_SHOP");

  let attempt = 0;

  while (attempt < 5) {
    attempt++;

    const response =
      await shopifyRequest(
        `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              query,
              variables
            })
        }
      );

    const payload =
      await response
        .json()
        .catch(() => ({}));

    if (
      response.status === 429
    ) {
      const wait =
        attempt * 2000;

      logSyncStatus(
        "SHOPIFY_THROTTLED",
        {
          attempt,
          wait
        }
      );

      await sleep(wait);

      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Shopify GraphQL HTTP ${response.status}: ${JSON.stringify(
          payload
        )}`
      );
    }

    if (
      payload.errors
    ) {
      const throttled =
        payload.errors.some(
          (error) =>
            error?.extensions
              ?.code ===
            "THROTTLED"
        );

      if (
        throttled &&
        attempt < 5
      ) {
        await sleep(
          attempt * 2000
        );

        continue;
      }

      throw new Error(
        `Shopify GraphQL request failed: ${JSON.stringify(
          payload.errors
        )}`
      );
    }

    const cost =
      payload.extensions
        ?.cost;

    const throttle =
      cost
        ?.throttleStatus;

    if (cost) {
      logSyncStatus(
        "SHOPIFY_API_COST",
        {
          requested:
            cost.requestedQueryCost,

          actual:
            cost.actualQueryCost,

          available:
            throttle
              ?.currentlyAvailable
        }
      );
    }

    if (
      throttle &&
      throttle.currentlyAvailable <
        200
    ) {
      await sleep(500);
    }

    return payload.data;
  }

  throw new Error(
    "Shopify GraphQL request failed after retries."
  );
}


/* =========================================================
   BASIC PRODUCT QUERY

   Keep this query relatively small.
========================================================= */

const PRODUCTS_QUERY = `
query Products(
  $first: Int!,
  $after: String
) {
  products(
    first: $first,
    after: $after
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

        deliveryTime: metafield(
          namespace: "custom",
          key: "delivery_time"
        ) {
          value
        }

        collections(first: 100) {
          edges {
            node {
              id
              handle
            }
          }
        }

        images(first: 2) {
          edges {
            node {
              url
            }
          }
        }

        variants(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }

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
`;


/* =========================================================
   FETCH PRODUCTS
========================================================= */

async function fetchAllProducts() {
  const products = [];

  const collectionIds =
    new Set();

  let cursor = null;

  let hasNextPage = true;

  let page = 0;

  logSyncStatus(
    "FETCHING_PRODUCTS"
  );

  while (hasNextPage) {
    page++;

    const data =
      await shopifyGraphQL(
        PRODUCTS_QUERY,
        {
          first:
            PRODUCT_PAGE_SIZE,

          after:
            cursor
        }
      );

    const connection =
      data?.products;

    if (!connection) {
      throw new Error(
        "Shopify products response is missing."
      );
    }

    for (
      const edge
      of connection.edges
    ) {
      const node =
        edge.node;

      const collections =
        (
          node.collections
            ?.edges ||
          []
        ).map(
          ({
            node:
              collection
          }) => {

            const id =
              collection.id
                .split("/")
                .pop();

            collectionIds.add(
              id
            );

            return {
              id,

              gid:
                collection.id,

              handle:
                collection.handle
            };
          }
        );

      products.push({
        node,
        collections,
        metaobjectColors: []
      });
    }

    logSyncStatus(
      "PRODUCT_PAGE_FETCHED",
      {
        page,

        productsOnPage:
          connection.edges.length,

        totalProductsFetched:
          products.length
      }
    );

    hasNextPage =
      Boolean(
        connection.pageInfo
          .hasNextPage
      );

    cursor =
      connection.pageInfo
        .endCursor;

    await sleep(150);
  }

  return {
    products,

    collectionIds:
      [...collectionIds]
  };
}


/* =========================================================
   FETCH REMAINING VARIANTS
========================================================= */

const PRODUCT_VARIANTS_QUERY = `
query ProductVariants(
  $id: ID!,
  $first: Int!,
  $after: String
) {
  product(id: $id) {
    variants(
      first: $first,
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }

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
`;


async function fetchRemainingVariants(
  product
) {
  const initialConnection =
    product.node
      ?.variants;

  if (
    !initialConnection
      ?.pageInfo
      ?.hasNextPage
  ) {
    return;
  }

  let cursor =
    initialConnection
      .pageInfo
      .endCursor;

  let hasNextPage = true;

  logSyncStatus(
    "FETCHING_EXTRA_VARIANTS",
    {
      productId:
        product.node.id,

      product:
        product.node.title
    }
  );

  while (hasNextPage) {
    const data =
      await shopifyGraphQL(
        PRODUCT_VARIANTS_QUERY,
        {
          id:
            product.node.id,

          first:
            VARIANT_PAGE_SIZE,

          after:
            cursor
        }
      );

    const connection =
      data?.product
        ?.variants;

    if (!connection) {
      break;
    }

    product.node
      .variants
      .edges
      .push(
        ...connection.edges
      );

    hasNextPage =
      Boolean(
        connection.pageInfo
          .hasNextPage
      );

    cursor =
      connection.pageInfo
        .endCursor;

    await sleep(100);
  }
}


/* =========================================================
   COLOR HELPERS
========================================================= */

function standardizeColorLabel(
  value
) {
  const label =
    String(
      value ||
      ""
    ).trim();

  if (!label) {
    return null;
  }

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
    ].includes(
      comparable
    )
  ) {
    return "Multicolour";
  }

  return label;
}


function uniqueStrings(values) {
  const result = [];

  const seen =
    new Set();

  for (
    const value
    of values
  ) {
    const clean =
      standardizeColorLabel(
        value
      );

    if (!clean) {
      continue;
    }

    const key =
      clean
        .trim()
        .toLowerCase();

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(clean);
  }

  return result;
}


/* =========================================================
   EXTRACT COLOR FROM METAOBJECT
========================================================= */

function extractMetaobjectColor(
  metaobject
) {
  if (!metaobject) {
    return [];
  }

  const colors = [];

  /*
   * displayName is normally the Shopify
   * standard color name.
   */

  if (
    metaobject.displayName
  ) {
    colors.push(
      metaobject.displayName
    );
  }

  /*
   * Also inspect fields in case the actual
   * color label is stored there.
   */

  for (
    const field
    of metaobject.fields ||
    []
  ) {
    const key =
      String(
        field.key ||
        ""
      )
        .trim()
        .toLowerCase();

    if (
      [
        "label",
        "name",
        "color",
        "colour"
      ].includes(key)
    ) {
      if (
        field.value
      ) {
        colors.push(
          field.value
        );
      }
    }
  }

  return uniqueStrings(
    colors
  );
}


/* =========================================================
   FETCH PRODUCT COLOR METAOBJECTS

   Separate query prevents main product query
   from exceeding Shopify query cost.
========================================================= */

const PRODUCT_METAFIELDS_QUERY = `
query ProductMetafields(
  $id: ID!,
  $first: Int!,
  $after: String
) {
  product(id: $id) {
    metafields(
      first: $first,
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }

      edges {
        node {
          id
          namespace
          key
          type
          value

          reference {
            ... on Metaobject {
              id
              type
              displayName

              fields {
                key
                value
              }
            }
          }

          references(
            first: 100
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }

            edges {
              node {
                ... on Metaobject {
                  id
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
  }
}
`;


/* =========================================================
   PAGINATE METAFIELD REFERENCES
========================================================= */

const METAFIELD_REFERENCES_QUERY = `
query MetafieldReferences(
  $id: ID!,
  $first: Int!,
  $after: String
) {
  node(id: $id) {
    ... on Metafield {
      references(
        first: $first,
        after: $after
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }

        edges {
          node {
            ... on Metaobject {
              id
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
`;


/* =========================================================
   FETCH EXTRA METAOBJECT REFERENCES
========================================================= */

async function fetchRemainingMetafieldReferences(
  metafield
) {
  const references =
    metafield
      ?.references;

  if (
    !references
      ?.pageInfo
      ?.hasNextPage
  ) {
    return [];
  }

  const metaobjects = [];

  let cursor =
    references
      .pageInfo
      .endCursor;

  let hasNextPage =
    true;

  while (hasNextPage) {
    const data =
      await shopifyGraphQL(
        METAFIELD_REFERENCES_QUERY,
        {
          id:
            metafield.id,

          first:
            REFERENCE_PAGE_SIZE,

          after:
            cursor
        }
      );

    const connection =
      data?.node
        ?.references;

    if (!connection) {
      break;
    }

    for (
      const edge
      of connection.edges ||
      []
    ) {
      if (
        edge?.node
      ) {
        metaobjects.push(
          edge.node
        );
      }
    }

    hasNextPage =
      Boolean(
        connection.pageInfo
          .hasNextPage
      );

    cursor =
      connection.pageInfo
        .endCursor;

    await sleep(75);
  }

  return metaobjects;
}


/* =========================================================
   CHECK WHETHER METAOBJECT IS COLOR
========================================================= */

function isColorMetaobject(
  metaobject
) {
  if (!metaobject) {
    return false;
  }

  const type =
    String(
      metaobject.type ||
      ""
    )
      .trim()
      .toLowerCase();

  return (
    type ===
      "shopify--color-pattern" ||
    type.includes(
      "color"
    ) ||
    type.includes(
      "colour"
    )
  );
}


/* =========================================================
   CHECK WHETHER METAFIELD LOOKS LIKE COLOR
========================================================= */

function isColorMetafield(
  metafield
) {
  const namespace =
    String(
      metafield.namespace ||
      ""
    )
      .trim()
      .toLowerCase();

  const key =
    String(
      metafield.key ||
      ""
    )
      .trim()
      .toLowerCase();

  const combined =
    `${namespace}.${key}`;

  return (
    combined.includes(
      "color"
    ) ||
    combined.includes(
      "colour"
    )
  );
}


/* =========================================================
   FETCH COLORS FOR ONE PRODUCT
========================================================= */

async function fetchProductMetaobjectColors(
  product
) {
  const colors = [];

  let cursor = null;

  let hasNextPage =
    true;

  while (hasNextPage) {
    const data =
      await shopifyGraphQL(
        PRODUCT_METAFIELDS_QUERY,
        {
          id:
            product.node.id,

          first:
            METAFIELD_PAGE_SIZE,

          after:
            cursor
        }
      );

    const connection =
      data?.product
        ?.metafields;

    if (!connection) {
      break;
    }

    for (
      const edge
      of connection.edges ||
      []
    ) {
      const metafield =
        edge.node;

      const metaobjects = [];

      if (
        metafield.reference
      ) {
        metaobjects.push(
          metafield.reference
        );
      }

      for (
        const referenceEdge
        of metafield.references
          ?.edges ||
        []
      ) {
        if (
          referenceEdge?.node
        ) {
          metaobjects.push(
            referenceEdge.node
          );
        }
      }

      if (
        metafield.references
          ?.pageInfo
          ?.hasNextPage
      ) {
        const remaining =
          await fetchRemainingMetafieldReferences(
            metafield
          );

        metaobjects.push(
          ...remaining
        );
      }

      for (
        const metaobject
        of metaobjects
      ) {
        if (
          isColorMetaobject(
            metaobject
          ) ||
          isColorMetafield(
            metafield
          )
        ) {
          colors.push(
            ...extractMetaobjectColor(
              metaobject
            )
          );
        }
      }

      /*
       * Handle normal text/list metafields
       * called color/colour as well.
       */

      if (
        isColorMetafield(
          metafield
        ) &&
        metafield.value
      ) {
        let parsed =
          metafield.value;

        try {
          parsed =
            JSON.parse(
              metafield.value
            );
        } catch {
          // Normal string.
        }

        if (
          Array.isArray(
            parsed
          )
        ) {
          colors.push(
            ...parsed
          );
        } else if (
          typeof parsed ===
          "string"
        ) {
          /*
           * Do not add Shopify GIDs as colors.
           */

          if (
            !parsed.startsWith(
              "gid://"
            )
          ) {
            colors.push(
              parsed
            );
          }
        }
      }
    }

    hasNextPage =
      Boolean(
        connection.pageInfo
          .hasNextPage
      );

    cursor =
      connection.pageInfo
        .endCursor;

    await sleep(75);
  }

  return uniqueStrings(
    colors
  );
}


/* =========================================================
   FETCH METAOBJECT COLORS FOR ALL PRODUCTS
========================================================= */

async function fetchAllProductColors(
  products
) {
  logSyncStatus(
    "FETCHING_PRODUCT_COLORS",
    {
      products:
        products.length
    }
  );

  let found =
    0;

  for (
    let index = 0;
    index < products.length;
    index++
  ) {
    const product =
      products[index];

    try {
      product.metaobjectColors =
        await fetchProductMetaobjectColors(
          product
        );

      if (
        product
          .metaobjectColors
          .length
      ) {
        found++;
      }
    } catch (error) {
      /*
       * Do not kill 40k product sync because
       * one product has a malformed metafield.
       */

      logSyncStatus(
        "PRODUCT_COLOR_FETCH_FAILED",
        {
          productId:
            product.node.id,

          product:
            product.node.title,

          error:
            error.message
        }
      );

      product.metaobjectColors =
        [];
    }

    if (
      (index + 1) %
        100 ===
      0 ||
      index ===
        products.length -
          1
    ) {
      logSyncStatus(
        "PRODUCT_COLORS_PROGRESS",
        {
          processed:
            index + 1,

          total:
            products.length,

          productsWithMetaobjectColors:
            found
        }
      );
    }
  }
}


/* =========================================================
   COLLECTION POSITIONS

   /collects.json works for manual/custom
   collections.

   Smart Collections return an error and are
   skipped instead of stopping the sync.
========================================================= */

async function fetchAllCollects(
  collectionIds
) {
  const shop =
    requiredEnv("SHOPIFY_SHOP");

  const result = {};

  let current = 0;
  let skipped = 0;

  for (
    const collectionId
    of collectionIds
  ) {
    current++;

    result[
      collectionId
    ] = {};

    logSyncStatus(
      "FETCHING_COLLECTION_POSITIONS",
      {
        collection:
          current,

        totalCollections:
          collectionIds.length,

        collectionId
      }
    );

    let url =
      `https://${shop}/admin/api/${API_VERSION}/collects.json` +
      `?collection_id=${collectionId}` +
      `&limit=250`;

    let skippedCollection =
      false;

    while (url) {
      const response =
        await shopifyRequest(
          url,
          {
            method: "GET",

            headers: {
              Accept:
                "application/json"
            }
          }
        );

      const payload =
        await response
          .json()
          .catch(() => ({}));

      if (
        response.status === 404
      ) {
        const errorText =
          JSON.stringify(
            payload
          )
            .toLowerCase();

        if (
          errorText.includes(
            "smartcollection"
          ) ||
          errorText.includes(
            "smart collection"
          )
        ) {
          skipped++;

          skippedCollection =
            true;

          logSyncStatus(
            "SMART_COLLECTION_SKIPPED",
            {
              collection:
                current,

              totalCollections:
                collectionIds.length,

              collectionId
            }
          );

          break;
        }
      }

      if (!response.ok) {
        throw new Error(
          `Shopify Collect request failed (${response.status}): ${JSON.stringify(
            payload
          )}`
        );
      }

      for (
        const collect
        of payload.collects ||
        []
      ) {
        const productId =
          String(
            collect.product_id
          );

        const position =
          Number(
            collect.position
          );

        result[
          collectionId
        ][
          productId
        ] =
          position;
      }

      const link =
        response.headers.get(
          "link"
        );

      url =
        link?.match(
          /<([^>]+)>;\s*rel="next"/
        )?.[1] ||
        null;
    }

    if (
      !skippedCollection
    ) {
      logSyncStatus(
        "COLLECTION_POSITIONS_FETCHED",
        {
          collection:
            current,

          totalCollections:
            collectionIds.length,

          collectionId,

          products:
            Object.keys(
              result[
                collectionId
              ]
            ).length
        }
      );
    }

    await sleep(100);
  }

  logSyncStatus(
    "COLLECTION_POSITIONS_COMPLETED",
    {
      totalCollections:
        collectionIds.length,

      smartCollectionsSkipped:
        skipped,

      manualCollectionsProcessed:
        collectionIds.length -
        skipped
    }
  );

  return result;
}


/* =========================================================
   BEST SELLING
========================================================= */

async function fetchBestSelling() {
  let collectionId =
    process.env
      .SHOPIFY_BEST_SELLING_COLLECTION_ID
      ?.trim();

  if (!collectionId) {
    logSyncStatus(
      "BEST_SELLING_COLLECTION_NOT_SET"
    );

    return {};
  }

  /*
   * Allow numeric collection ID in .env.
   */

  if (
    /^\d+$/.test(
      collectionId
    )
  ) {
    collectionId =
      `gid://shopify/Collection/${collectionId}`;
  }

  const ranks = {};

  let cursor = null;

  let rank = 1;

  let page = 0;

  let hasNextPage =
    true;

  const query = `
    query BestSelling(
      $id: ID!,
      $first: Int!,
      $after: String
    ) {
      collection(id: $id) {
        products(
          first: $first,
          after: $after,
          sortKey: BEST_SELLING
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
  `;

  while (hasNextPage) {
    page++;

    const data =
      await shopifyGraphQL(
        query,
        {
          id:
            collectionId,

          first:
            250,

          after:
            cursor
        }
      );

    const products =
      data?.collection
        ?.products;

    if (!products) {
      logSyncStatus(
        "BEST_SELLING_COLLECTION_NOT_FOUND",
        {
          collectionId
        }
      );

      return {};
    }

    for (
      const edge
      of products.edges
    ) {
      const productId =
        edge.node.id
          .split("/")
          .pop();

      ranks[
        productId
      ] =
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
      Boolean(
        products.pageInfo
          .hasNextPage
      );

    cursor =
      products.pageInfo
        .endCursor;

    await sleep(100);
  }

  return ranks;
}


/* =========================================================
   OPTION HELPERS
========================================================= */

function optionValue(
  selectedOptions,
  names
) {
  const accepted =
    names.map(
      (name) =>
        String(name)
          .trim()
          .toLowerCase()
    );

  const option =
    (
      selectedOptions ||
      []
    ).find(
      (item) =>
        accepted.includes(
          String(
            item.name ||
            ""
          )
            .trim()
            .toLowerCase()
        )
    );

  return (
    option?.value ||
    null
  );
}


/* =========================================================
   PROCESS PRODUCT
========================================================= */

function processProduct(
  product,
  collectsMap,
  bestSellingMap
) {
  const {
    node,
    collections
  } =
    product;

  const productId =
    node.id
      .split("/")
      .pop();


  /* ---------------------------------------------------------
     COLLECTION POSITION
  --------------------------------------------------------- */

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
            Number(
              position
            )
          )
      )
      .map(Number);


  /* ---------------------------------------------------------
     VARIANTS
  --------------------------------------------------------- */

  const variants =
    (
      node.variants
        ?.edges ||
      []
    ).map(
      ({
        node:
          variant
      }) => {

        const selectedOptions =
          variant.selectedOptions ||
          [];

        const inventory =
          Number(
            variant
              .inventoryQuantity ||
            0
          );

        /*
         * Preserve ALL Shopify option values.
         */

        const options = {};

        for (
          const option
          of selectedOptions
        ) {
          const name =
            String(
              option.name ||
              ""
            ).trim();

          const value =
            String(
              option.value ||
              ""
            ).trim();

          if (
            name &&
            value
          ) {
            options[
              name
            ] =
              value;
          }
        }

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
            inventory,

          available:
            inventory > 0,

          size:
            optionValue(
              selectedOptions,
              [
                "size"
              ]
            ),

          color:
            optionValue(
              selectedOptions,
              [
                "color",
                "colour"
              ]
            ),

          /*
           * Keeps all options such as:
           * Size
           * Color
           * Style
           * Material
           * etc.
           */

          options,

          selected_options:
            selectedOptions.map(
              (option) => ({
                name:
                  option.name,

                value:
                  option.value
              })
            )
        };
      }
    );


  /* ---------------------------------------------------------
     VARIANT COLORS
  --------------------------------------------------------- */

  const variantColors =
    uniqueStrings(
      variants
        .map(
          (variant) =>
            variant.color
        )
        .filter(Boolean)
    );


  /* ---------------------------------------------------------
     METAOBJECT COLORS
  --------------------------------------------------------- */

  const metaobjectColors =
    uniqueStrings(
      product
        .metaobjectColors ||
      []
    );


  /* ---------------------------------------------------------
     FINAL COLORS

     IMPORTANT:

     Do NOT choose one source over another.

     Combine:
     - Shopify Color Pattern metaobjects
     - Color metafields
     - Variant Color option

     This prevents missing color values.
  --------------------------------------------------------- */

  const colors =
    uniqueStrings([
      ...metaobjectColors,
      ...variantColors
    ]);


  /* ---------------------------------------------------------
     INVENTORY
  --------------------------------------------------------- */

  const inventoryQuantity =
    variants.reduce(
      (
        total,
        variant
      ) =>
        total +
        Number(
          variant
            .inventory_quantity ||
          0
        ),
      0
    );


  /* ---------------------------------------------------------
     PRICE
  --------------------------------------------------------- */

  const prices =
    variants
      .map(
        (variant) =>
          Number(
            variant.price
          )
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


  /* ---------------------------------------------------------
     IMAGES
  --------------------------------------------------------- */

  const images =
    (
      node.images
        ?.edges ||
      []
    )
      .map(
        ({
          node:
            image
        }) =>
          image?.url
      )
      .filter(Boolean);


  /* ---------------------------------------------------------
     FINAL ROW
  --------------------------------------------------------- */

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
      ] ??
      9999,

    price:
      minimumPrice,

    images,

    image:
      images[0] ||
      null,

    image2:
      images[1] ||
      null,

    /*
     * Combined complete color array.
     */

    color:
      colors,

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
      node.deliveryTime
        ?.value ||
      null,

    created_at:
      node.createdAt,

    published_at:
      node.publishedAt
  };
}


/* =========================================================
   UPLOAD PRODUCTS TO SUPABASE
========================================================= */

async function uploadProducts(
  rows
) {
  const supabase =
    getSupabase();

  const totalBatches =
    Math.ceil(
      rows.length /
      SUPABASE_BATCH_SIZE
    );

  for (
    let index = 0;
    index < rows.length;
    index +=
      SUPABASE_BATCH_SIZE
  ) {
    const batch =
      rows.slice(
        index,
        index +
          SUPABASE_BATCH_SIZE
      );

    const batchNumber =
      Math.floor(
        index /
        SUPABASE_BATCH_SIZE
      ) + 1;

    logSyncStatus(
      "UPLOADING_BATCH",
      {
        batch:
          batchNumber,

        totalBatches,

        batchSize:
          batch.length
      }
    );

    const {
      error
    } =
      await supabase
        .from(
          "products"
        )
        .upsert(
          batch,
          {
            onConflict:
              "id"
          }
        );

    if (error) {
      throw new Error(
        `Supabase products upsert failed: ${error.message}`
      );
    }

    logSyncStatus(
      "BATCH_UPLOADED",
      {
        batch:
          batchNumber,

        totalBatches
      }
    );
  }
}


/* =========================================================
   MAIN SYNC
========================================================= */

export async function syncProducts() {
  validateEnvironment();

  getSupabase();


  /* ---------------------------------------------------------
     1. FETCH PRODUCTS
  --------------------------------------------------------- */

  const {
    products,
    collectionIds
  } =
    await fetchAllProducts();


  /* ---------------------------------------------------------
     2. FETCH REMAINING VARIANTS
  --------------------------------------------------------- */

  logSyncStatus(
    "CHECKING_PRODUCT_VARIANTS",
    {
      products:
        products.length
    }
  );

  let productsWithExtraVariants =
    0;

  for (
    let index = 0;
    index < products.length;
    index++
  ) {
    const product =
      products[index];

    if (
      product.node
        ?.variants
        ?.pageInfo
        ?.hasNextPage
    ) {
      productsWithExtraVariants++;

      await fetchRemainingVariants(
        product
      );
    }

    if (
      (index + 1) %
        500 ===
      0
    ) {
      logSyncStatus(
        "VARIANT_CHECK_PROGRESS",
        {
          processed:
            index + 1,

          total:
            products.length,

          productsWithExtraVariants
        }
      );
    }
  }


  /* ---------------------------------------------------------
     3. FETCH ALL COLOR METAOBJECTS/METAFIELDS
  --------------------------------------------------------- */

  await fetchAllProductColors(
    products
  );


  /* ---------------------------------------------------------
     4. COLLECTION POSITIONS + BEST SELLING
  --------------------------------------------------------- */

  const [
    collectsMap,
    bestSellingMap
  ] =
    await Promise.all([
      fetchAllCollects(
        collectionIds
      ),

      fetchBestSelling()
    ]);


  /* ---------------------------------------------------------
     5. PROCESS PRODUCTS
  --------------------------------------------------------- */

  logSyncStatus(
    "PROCESSING_PRODUCTS",
    {
      products:
        products.length,

      collections:
        collectionIds.length
    }
  );

  const rows =
    products.map(
      (product) =>
        processProduct(
          product,
          collectsMap,
          bestSellingMap
        )
    );


  /* ---------------------------------------------------------
     COLOR DEBUG SUMMARY
  --------------------------------------------------------- */

  const productsWithColors =
    rows.filter(
      (product) =>
        Array.isArray(
          product.color
        ) &&
        product.color.length >
          0
    ).length;

  const productsWithoutColors =
    rows.length -
    productsWithColors;

  const allColors =
    uniqueStrings(
      rows.flatMap(
        (product) =>
          product.color ||
          []
      )
    );

  logSyncStatus(
    "COLOR_SUMMARY",
    {
      productsWithColors,

      productsWithoutColors,

      uniqueColors:
        allColors.length,

      colors:
        allColors
    }
  );


  /* ---------------------------------------------------------
     6. UPLOAD
  --------------------------------------------------------- */

  await uploadProducts(
    rows
  );


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

      productsWithColors,

      productsWithoutColors,

      uniqueColors:
        allColors.length,

      lastUpdatedAt
    }
  );

  return {
    syncedProducts:
      rows.length,

    productsWithColors,

    productsWithoutColors,

    uniqueColors:
      allColors.length,

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
      requireCronSecret:
        true
    });

    if (
      req.method !==
      "GET"
    ) {
      return res
        .status(405)
        .json({
          ok: false,

          error:
            "Method not allowed"
        });
    }

    if (
      req.headers
        .authorization !==
      `Bearer ${process.env.CRON_SECRET}`
    ) {
      return res
        .status(401)
        .json({
          ok: false,

          error:
            "Unauthorized"
        });
    }

    logSyncStatus(
      "SYNC_STARTED",
      {
        trigger:
          "api"
      }
    );

    const result =
      await syncProducts();

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

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
        trigger:
          "api",

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
   COMMAND LINE RUNNER

   Both work:

   node sync.js
   node sync.js --run
========================================================= */

async function runFromCommandLine() {
  console.log(
    "\n=========================================="
  );

  console.log(
    " Shopify -> Supabase Sync"
  );

  console.log(
    "==========================================\n"
  );

  try {
    console.log(
      "Environment:"
    );

    const envNames = [
      "SHOPIFY_SHOP",
      "SHOPIFY_CLIENT_ID",
      "SHOPIFY_CLIENT_SECRET",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY"
    ];

    for (
      const name
      of envNames
    ) {
      console.log(
        `${name}: ${
          process.env[name]
            ? "OK"
            : "MISSING"
        }`
      );
    }

    console.log("");

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
      `Products with colors: ${result.productsWithColors}`
    );

    console.log(
      `Products without colors: ${result.productsWithoutColors}`
    );

    console.log(
      `Unique colors: ${result.uniqueColors}`
    );

    console.log(
      `Last updated: ${result.lastUpdatedAt}`
    );

    console.log(
      "==========================================\n"
    );

    process.exitCode =
      0;

  } catch (error) {
    logSyncStatus(
      "SYNC_FAILED",
      {
        trigger:
          "command-line",

        error:
          error.message
      }
    );

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

    process.exitCode =
      1;
  }
}


/* =========================================================
   DIRECT RUN DETECTION
========================================================= */

const isDirectRun =
  process.argv[1] &&
  process.argv[1]
    .replace(
      /\\/g,
      "/"
    )
    .toLowerCase()
    .endsWith(
      "/sync.js"
    );


if (
  isDirectRun ||
  process.argv.includes(
    "--run"
  )
) {
  runFromCommandLine();
}