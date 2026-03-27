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
      console.log("🔁 Retrying Shopify request...");
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
  products(first:250 ${cursor ? `, after:"${cursor}"` : ""}) {
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
        tags

        colorMetafield: metafield(namespace: "custom", key: "color") {
          value
        }

        fabricMetafield: metafield(namespace: "custom", key: "fabric") {
          value
        }

        collections(first:200){
          edges{
            node{ handle }
          }
        }

        images(first:1){
          edges{
            node{ url }
          }
        }

        variants(first:100){
          edges{
            node{
              price
              inventoryQuantity
              selectedOptions{
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

    console.log("📦 Fetching products...");

    const data = await shopifyFetch(query);

    const products = data.data.products.edges.map(p => {

      const tags = p.node.tags || [];
      const variants = p.node.variants.edges.map(v => v.node);

      let color = [];
      let size = [];
      let fabric = [];
      let delivery_time = [];

      /* ================= COLOR ================= */

      if (p.node.colorMetafield?.value) {
        try {
          const parsed = JSON.parse(p.node.colorMetafield.value);
          color = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          color = p.node.colorMetafield.value.split(",");
        }
      }

      if (!color.length) {
        const colorTags = tags
          .filter(t => t.toLowerCase().startsWith("color_"))
          .map(t => t.split("_")[1]);

        if (colorTags.length) {
          color = colorTags.flatMap(c => c.split(","));
        }
      }

      if (!color.length) {
        variants.forEach(v => {
          v.selectedOptions?.forEach(opt => {
            if (opt.name.toLowerCase().includes("color")) {
              color.push(...opt.value.split("/"));
            }
          });
        });
      }

      /* ================= SIZE ================= */

      variants.forEach(v => {
        v.selectedOptions?.forEach(opt => {
          if (opt.name.toLowerCase().includes("size")) {

            let value = opt.value;

            if (value.includes("-")) {
              value.split("-").forEach(s => size.push(s.trim()));
            } else if (value.includes("/")) {
              value.split("/").forEach(s => size.push(s.trim()));
            } else {
              size.push(value.trim());
            }
          }
        });
      });

      size = [...new Set(size.map(s => s.toUpperCase()))];

      /* ================= FABRIC (FIXED) ================= */

      // 1. FROM METAFIELD
      if (p.node.fabricMetafield?.value) {
        try {
          const parsed = JSON.parse(p.node.fabricMetafield.value);
          fabric = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          fabric = p.node.fabricMetafield.value.split(",");
        }
      }

      // 2. FROM VARIANTS
      if (!fabric.length) {
        variants.forEach(v => {
          v.selectedOptions?.forEach(opt => {
            if (opt.name.toLowerCase().includes("fabric")) {
              fabric.push(...opt.value.split("/"));
            }
          });
        });
      }

      // 3. FROM TAGS
      if (!fabric.length) {
        const fabricTags = tags
          .filter(t => t.toLowerCase().startsWith("fabric_"))
          .flatMap(t => t.split("_")[1].split(","));

        fabric.push(...fabricTags);
      }

      // CLEAN
      fabric = [...new Set(
        fabric.map(f => f.trim())
      )];

      /* ================= DELIVERY ================= */

      const deliveryTag = tags.find(t =>
        t.toLowerCase().startsWith("delivery_")
      );

      if (deliveryTag) {
        delivery_time = deliveryTag
          .split("_")[1]
          .split(",")
          .map(d => d.trim());
      }

      /* ================= CLEAN ================= */

      color = [...new Set(
        color.map(c => c.trim().toLowerCase())
      )].map(c => c.charAt(0).toUpperCase() + c.slice(1));

      size = [...new Set(size)];
      fabric = [...new Set(fabric)];
      delivery_time = [...new Set(delivery_time)];

      const SIZE_ORDER = [
        "XXS","XS","S","M","L","XL","XXL","3XL","4XL","5XL"
      ];

      size.sort((a, b) => {
        return SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b);
      });

      
      /* ================= VARIANTS ================= */

      const variantData = variants.map(v => ({
        color: v.selectedOptions?.find(o =>
          o.name.toLowerCase().includes("color")
        )?.value || "",
        size: v.selectedOptions?.find(o =>
          o.name.toLowerCase().includes("size")
        )?.value || "",
        inventory_quantity: v.inventoryQuantity || 0,
        price: parseFloat(v.price || 0)
      }));

      /* ================= PRICE + STOCK ================= */

      const price = variantData.length
        ? Math.min(...variantData.map(v => v.price))
        : 0;

      const totalInventory = variantData.reduce(
        (sum, v) => sum + (v.inventory_quantity || 0),
        0
      );

    const collections =
  p.node.collections.edges
    .map(c => c.node.handle)
    .filter(c =>
      ![
        "all",
        "orderlyemails-recommended-products",
        "frontpage",
        "homepage"
      ].includes(c)
    );

      return {
        id: p.node.id.split("/").pop(),
        title: p.node.title,
        handle: p.node.handle,
        vendor: p.node.vendor,
        product_type: p.node.productType,
        collection_handle: collections,
        price,
        variants: variantData,
        image: p.node.images.edges[0]?.node.url || null,
        status: p.node.status,
        published: p.node.status === "ACTIVE",
        inventory_quantity: totalInventory,
        color,
        size,
        fabric,
        delivery_time
      };
    });

    const { error } = await supabase
      .from("products")
      .upsert(products, { onConflict: "id" });

    if (error) {
      console.error("❌ SUPABASE ERROR:", error.message);
      return;
    }

    console.log("✅ Inserted:", products.length);

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;

    await sleep(1200);
  }

  console.log("🎉 All products synced successfully!");
}

/* ================= RUN ================= */

syncProducts();