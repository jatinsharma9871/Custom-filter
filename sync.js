import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

/* ================= CONFIG ================= */



const SHOP = "the-sverve.myshopify.com";
const TOKEN = "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";

const supabase = createClient(
  "https://rflabvnooobawvhxkuoi.supabase.co",
  "sb_publishable_7QPCLDGw0t6YloSbtA6Y0w_weJ86qO5"
);

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopifyFetch(query, retries = 3) {
  try {
    const response = await fetch(
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

    const json = await response.json();

    if (!response.ok || json.errors) {
      throw new Error(JSON.stringify(json.errors));
    }

    return json;

  } catch (err) {
    if (retries > 0) {
      console.log("Retrying Shopify request...");
      await sleep(2000);
      return shopifyFetch(query, retries - 1);
    }
    throw err;
  }
}

/* ================= SYNC ================= */

async function syncProducts() {

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {

    const query = `
    {
      products(first: 100 ${cursor ? `, after: "${cursor}"` : ""}) {
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
            images(first:1){ edges{ node{ url } } }
            variants(first:1){ edges{ node{ price } } }
          }
        }
      }
    }`;

    /* ---------- SAFE FETCH ---------- */

    const data = await shopifyFetch(query);

    /* ---------- TRANSFORM ---------- */

    const products = data.data.products.edges.map(p => {

      const tags = p.node.tags || [];

      const extractTag = (prefix) => {
        const found = tags.find(t =>
          t.toLowerCase().startsWith(prefix.toLowerCase() + "_")
        );
        return found ? found.split("_")[1] : null;
      };

      return {
        id: p.node.id.split("/").pop(), // safer ID
        title: p.node.title,
        handle: p.node.handle,
        vendor: p.node.vendor,
        product_type: p.node.productType,
        price: parseFloat(
          p.node.variants.edges[0]?.node.price || 0
        ),
        image: p.node.images.edges[0]?.node.url || null,

        color: extractTag("Color"),
        size: extractTag("Size"),
        fabric: extractTag("Fabric"),
        delivery_time: extractTag("Delivery"),

        collection: p.node.productType
      };
    });

    /* ---------- UPSERT ---------- */

    await supabase
      .from("products")
      .upsert(products, { onConflict: "id" });

    /* ---------- PAGINATION ---------- */

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;

    console.log("Batch synced");

    /* ---------- RATE LIMIT PROTECTION ---------- */
    await sleep(1200);
  }

  console.log("All products synced ✅");
}

/* ================= RUN ================= */

syncProducts();