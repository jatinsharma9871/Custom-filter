import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async function handler(req, res) {

  const { minPrice, maxPrice, vendor, productType } = req.query;

  let query = supabase.from("products").select("*");

  if (minPrice) query = query.gte("price", minPrice);
  if (maxPrice) query = query.lte("price", maxPrice);
  if (vendor) query = query.eq("vendor", vendor);
  if (productType) query = query.eq("product_type", productType);

  const { data, error } = await query.limit(1000);

  if (error) return res.status(500).json(error);

  res.status(200).json(data);
}
