import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Package } from "lucide-react";
import { Panel } from "../shared/Panel";
import ProductCardMini from "./ProductCardMini";

// Produtos mostrados NESTE anúncio específico -- desde a introdução do
// catálogo por empresa (ver CONTEXTO.MD/Resumo.md seções 66-67), um produto
// não pertence mais a um único anúncio: `supplier_products` é a tabela de
// ligação que diz quais produtos do catálogo da empresa aparecem aqui.
export default function SupplierProductsSection({ supplierId }) {
  const { data: links = [], isLoading: isLoadingLinks } = useQuery({
    queryKey: ["supplier-products", supplierId],
    queryFn: () => api.entities.SupplierProduct.filter({ supplier_id: supplierId }),
    enabled: !!supplierId,
  });

  const productIds = links.map((link) => link.product_id);

  const { data: products = [], isLoading: isLoadingProducts } = useQuery({
    queryKey: ["products-by-ids", productIds],
    queryFn: async () => {
      const perProduct = await Promise.all(
        productIds.map((id) => api.entities.Product.filter({ id }))
      );
      // Só o que está publicado. Para o visitante a policy já esconde
      // pausados/suspensos (plan-limits-central.sql); o DONO, porém, lê os
      // próprios -- sem este filtro ele veria no seu anúncio produtos que o
      // público não vê.
      return perProduct.flat().filter((p) => (p.status || "active") === "active");
    },
    enabled: productIds.length > 0,
  });

  const { data: imagesByProduct = {} } = useQuery({
    queryKey: ["product-images-by-ids", productIds],
    queryFn: async () => {
      const perProduct = await Promise.all(
        productIds.map((id) => api.entities.ProductImage.filter({ product_id: id }, "position"))
      );
      return Object.fromEntries(productIds.map((id, index) => [id, perProduct[index].map((img) => img.url)]));
    },
    enabled: productIds.length > 0,
  });

  const isLoading = isLoadingLinks || (productIds.length > 0 && isLoadingProducts);

  if (isLoading) {
    return (
      <Panel>
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-card bg-slate-100 dark:bg-slate-800" />
          ))}
        </div>
      </Panel>
    );
  }

  if (products.length === 0) return null;

  return (
    <Panel title="Produtos e Serviços" icon={Package} count={products.length}>
      {/* DOIS por linha, não três (seção 146). A seção mora na coluna da
          galeria, que tem ~5/12 da largura -- com três o nome do produto
          truncava na primeira linha e o preço brigava com o "Mín:" ao lado. */}
      <div className="grid auto-rows-fr grid-cols-2 gap-4">
        {products.map((product) => (
          <ProductCardMini key={product.id} product={product} images={imagesByProduct[product.id] || []} />
        ))}
      </div>
    </Panel>
  );
}
