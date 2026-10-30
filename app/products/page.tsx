import { ProductsView } from "@/components/products/ProductsView";
import { publicPriceCatalog } from "@/lib/server/public-prices";
export default function Page() { return <ProductsView catalog={publicPriceCatalog()} />; }
