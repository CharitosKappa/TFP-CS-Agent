import { execKw } from "./client";
import { log } from "../observability/logger";

// Read-only stock/forecast from Odoo, mapped to TFP's warehouse model. Which
// internal location a unit sits in decides whether it's sellable, on its way, or
// neither — so we match location names EXPLICITLY (a blanket "TFP*" wrongly
// counts defective/scrap stock as incoming):
//   LGK/Stock          → SELLABLE (Shopify is 1:1 with this).
//   TFP/Main Stock     → supplier goods in-house, moving to LGK → INCOMING.
//   TFP-Returns/Stock  → confirmed customer returns being processed → INCOMING.
//   TFP/Studio         → held by the photo studio; will reach LGK (timing unknown) → INCOMING.
// Everything else (TFP/Defective, TFP/Scrap, LGK/Defective, LGK/Cancelled,
// LGK/NotFound, unused Hold/Output/Testing) NEVER becomes sellable → ignored.
// A size sold out on Shopify (LGK=0) with incoming>0 is "expected back shortly"
// — qualitative, no dates (we read physical stock only, not expected receipts).

const SELLABLE_LOCATIONS = new Set(["LGK/Stock"]);
const INCOMING_LOCATIONS = new Set(["TFP/Main Stock", "TFP-Returns/Stock", "TFP/Studio"]);

type Many2One = [number, string] | false;
const m2oName = (v: Many2One): string => (Array.isArray(v) ? v[1] : "");

export interface SizeAvailability {
  size: string | null;
  sellable: number; // LGK
  incoming: number; // TFP/Main + TFP-Returns
}

/** Parses the size out of an Odoo variant name, e.g. "[…] Sandals (Taupe Suede, 37)" → "37". */
function sizeFromName(name: string): string | null {
  return name.match(/,\s*([^),]+)\)\s*$/)?.[1]?.trim() ?? null;
}

/**
 * Per-size availability for a product, keyed by its SKU prefix (the 8-digit
 * colour SKU, or 5-digit master). Best-effort: [] on no access/error.
 */
export async function getSizeAvailabilityBySku(skuPrefix: string): Promise<SizeAvailability[]> {
  if (!/^\d{5,}$/.test(skuPrefix)) return [];
  try {
    const rows = await execKw<{ product_id: Many2One; available_quantity: number; location_id: Many2One }[]>(
      "stock.quant", "search_read",
      [[["product_id.default_code", "=like", `${skuPrefix}%`], ["location_id.usage", "=", "internal"]]],
      { fields: ["product_id", "available_quantity", "location_id"], limit: 300 },
    );
    const bySize = new Map<string, SizeAvailability>();
    for (const r of rows) {
      const size = sizeFromName(m2oName(r.product_id));
      const loc = m2oName(r.location_id);
      const key = size ?? m2oName(r.product_id);
      const e = bySize.get(key) ?? { size, sellable: 0, incoming: 0 };
      if (SELLABLE_LOCATIONS.has(loc)) e.sellable += r.available_quantity;
      else if (INCOMING_LOCATIONS.has(loc)) e.incoming += r.available_quantity;
      bySize.set(key, e);
    }
    return [...bySize.values()];
  } catch {
    log.error("odoo_stock_lookup_failed", {});
    return [];
  }
}
