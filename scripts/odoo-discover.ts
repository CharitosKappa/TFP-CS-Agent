import "dotenv/config";
import { execKw, odooHealthCheck } from "../src/lib/odoo/client";

// One-off discovery helper: connects to Odoo (staging) and prints the models
// that look RMA/return/repair related, plus a digest of each one's fields, so
// we can pick the exact model + field names for the read-only ACLs and the
// agent's lookups. Run: `npx tsx scripts/odoo-discover.ts`

// Substrings we search for in technical model names (ir.model.model).
const NEEDLES = ["rma", "repair", "return", "claim", "refund"];

interface IrModel {
  model: string;
  name: string;
}

interface FieldDef {
  type: string;
  string: string;
  relation?: string;
}

async function main() {
  console.log("→ Connecting to Odoo…");
  console.log("  ", await odooHealthCheck());

  // Find candidate models by technical name (`ilike` is case-insensitive).
  // Odoo domains use prefix-notation OR: N-1 "|" operators chain N leaf terms.
  const orDomain: unknown[] = [];
  for (let i = 0; i < NEEDLES.length - 1; i++) orDomain.push("|");
  for (const n of NEEDLES) orDomain.push(["model", "ilike", n]);

  const models = await execKw<IrModel[]>("ir.model", "search_read", [orDomain], {
    fields: ["model", "name"],
    order: "model",
  });

  if (models.length === 0) {
    console.log("\nNo models matched", NEEDLES, "— the RMA module may be named differently.");
    console.log("Listing ALL custom (x_/non-base) models so we can spot it:");
    const all = await execKw<IrModel[]>("ir.model", "search_read", [[]], {
      fields: ["model", "name"],
      order: "model",
    });
    for (const m of all) console.log(`  ${m.model.padEnd(40)} ${m.name}`);
    return;
  }

  console.log(`\nFound ${models.length} candidate model(s):`);
  for (const m of models) console.log(`  ${m.model.padEnd(35)} ${m.name}`);

  // Dump fields for each candidate.
  for (const m of models) {
    console.log(`\n── Fields of ${m.model} (${m.name}) ──`);
    const fields = await execKw<Record<string, FieldDef>>(m.model, "fields_get", [], {
      attributes: ["type", "string", "relation"],
    });
    const rows = Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, f]) => {
        const rel = f.relation ? ` → ${f.relation}` : "";
        return `  ${key.padEnd(28)} ${f.type.padEnd(12)} ${f.string}${rel}`;
      });
    console.log(rows.join("\n"));
  }

  console.log("\nDone. Pick the model + fields you need and tell me which they are.");
}

main().catch((e) => {
  console.error("✗ discovery failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
