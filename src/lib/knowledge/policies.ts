import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

let cached: string | null = null;

/**
 * Loads the policy/knowledge text injected into the cached system prompt.
 *
 * Reads every `.md`/`.txt` file in `knowledge/` (sorted) and concatenates them,
 * so you can drop in policies, FAQs, or exported website pages as separate files.
 *
 * Because the corpus is small and bounded, we inject it whole (with prompt
 * caching) rather than building a vector/RAG pipeline. Phase 2+: convert
 * PDF/Word sources to text files here.
 */
export async function loadPolicies(): Promise<string> {
  if (cached) return cached;
  const dir = join(process.cwd(), "knowledge");
  const files = (await readdir(dir)).filter((f) => /\.(md|txt)$/i.test(f)).sort();
  const texts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
  cached = texts.join("\n\n---\n\n");
  return cached;
}
