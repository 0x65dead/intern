// `npm run docs` — write the generated documents to disk.
//
// Separate from the renderers so that the renderers stay pure and testable: the
// test compares bytes against renderCapabilityDoc() without touching the file
// system, and this is the only thing that writes.

import fs from "fs";
import path from "path";
import { renderCapabilityDoc } from "./capability";
import { renderReadme } from "./readme";
import { ENV_TEMPLATE } from "../util/env";

/**
 * `render` receives the file's current text, or "" when it does not exist.
 *
 * A whole-file generator ignores it; a managed-block generator edits it. Passing
 * it either way keeps both kinds in one list.
 */
const OUTPUTS: { file: string; render: (current: string) => string }[] = [
  { file: "CAPABILITY.md", render: () => renderCapabilityDoc() },
  { file: "README.md", render: renderReadme },
  // The same bytes `intern init` writes. An .env.example that documents fewer
  // settings than the parser reads is how a safety flag goes unnoticed.
  { file: ".env.example", render: () => ENV_TEMPLATE },
];

function main(): void {
  const root = process.cwd();
  for (const out of OUTPUTS) {
    const target = path.resolve(root, out.file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    const next = out.render(current ?? "");
    if (current === next) {
      process.stdout.write(`${out.file} is up to date\n`);
      continue;
    }
    fs.writeFileSync(target, next, "utf8");
    process.stdout.write(`${out.file} written (${next.length} bytes)\n`);
  }
}

main();
