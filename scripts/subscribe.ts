import "dotenv/config";
import {
  createInboxSubscription,
  deleteSubscription,
  listSubscriptions,
} from "../src/lib/graph/subscriptions";

// Usage: npx tsx scripts/subscribe.ts [create|list|delete <id>]
async function main() {
  const cmd = process.argv[2] ?? "create";
  if (cmd === "create") {
    const sub = await createInboxSubscription();
    console.log("Created subscription:", sub.id, "→ expires", sub.expirationDateTime);
  } else if (cmd === "list") {
    console.log(await listSubscriptions());
  } else if (cmd === "delete") {
    const id = process.argv[3];
    if (!id) throw new Error("usage: subscribe delete <subscriptionId>");
    await deleteSubscription(id);
    console.log("Deleted", id);
  } else {
    throw new Error(`unknown command: ${cmd} (use create | list | delete <id>)`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
