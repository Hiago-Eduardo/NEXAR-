import React from "react";
import { Package } from "lucide-react";
import { Panel } from "../shared/Panel";
import ProductCardMini from "./ProductCardMini";

// Catálogo COMPLETO da empresa (todos os produtos da conta, não só os
// vinculados a este anúncio) -- usado na visão ?view=empresa de
// SupplierProfile.jsx. `products` já vem da RPC company_public_products
// (supabase/product-catalog.sql) com as imagens agregadas por produto.
export default function CompanyProductsSection({ products = [] }) {
  if (products.length === 0) return null;

  return (
    <Panel title="Catálogo da empresa" icon={Package} count={products.length}>
      <div className="grid auto-rows-fr gap-4 sm:grid-cols-2">
        {products.map((product) => (
          <ProductCardMini key={product.id} product={product} images={product.images || []} />
        ))}
      </div>
    </Panel>
  );
}
