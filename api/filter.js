
import fetch from "node-fetch";

export default async function handler(req, res) {
  const { minPrice, maxPrice, vendor, productType } = req.query;

  const SHOP = process.env.SHOPIFY_STORE;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  const query = `
    {
      products(first: 250) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
            images(first: 1) {
              edges {
                node {
                  url
                }
              }
            }
          }
        }
      }
    }
  `;

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

  const data = await response.json();

  let products = data.data.products.edges.map(p => p.node);

  // Apply filters
  products = products.filter(p => {
    const price = parseFloat(p.variants.edges[0].node.price);

    if (minPrice && price < parseFloat(minPrice)) return false;
    if (maxPrice && price > parseFloat(maxPrice)) return false;
    if (vendor && p.vendor !== vendor) return false;
    if (productType && p.productType !== productType) return false;

    return true;
  });

  res.status(200).json(products);
}
