#!/usr/bin/env node
// Checks that every relative Markdown link and image in the given files
// points at an existing file in the repo. Usage: node scripts/check-doc-links.mjs
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { globSync } from "node:fs";

const roots = [
  ...globSync("docs/en/**/*.md"),
  ...globSync("docs/zh/**/*.md"),
  "README.md",
  "core/README.md",
  "app/AGENTS.md",
];

const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let dead = 0;
let checked = 0;

for (const file of roots) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkRe)) {
    const raw = match[1] ?? match[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("mailto:")) continue; // absolute/anchor
    const target = raw.split("#")[0];
    if (!target) continue;
    const full = resolve(dirname(file), target);
    checked += 1;
    if (!existsSync(full)) {
      dead += 1;
      console.error(`DEAD ${file} -> ${raw}`);
    }
  }
}

console.log(`checked ${checked} relative links across ${roots.length} files`);
if (dead > 0) {
  console.error(`${dead} dead link(s)`);
  process.exit(1);
}
console.log("all links OK");
