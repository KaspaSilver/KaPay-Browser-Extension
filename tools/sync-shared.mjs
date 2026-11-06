// Refreshes shared/ from a KaChat-Desktop checkout - from its committed HEAD, never its working
// tree, so work the Desktop session hasn't committed yet is never picked up. The wallet's engine (addresses, signing,
// nodes, KNS, prices), the KasSigner KSPT code and the Kaspa WASM SDK are KaChat-Desktop's;
// this repo carries copies so it builds on its own. Run it when the desktop engine changes,
// then build, test and commit shared/ with the commit it came from in the message.
//
//   npm run sync-shared [-- /path/to/KaChat-Desktop]     (default: ../KaChat-Desktop)
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const desktop = resolve(process.argv[2] || `${root}../KaChat-Desktop`);
if (!existsSync(`${desktop}/engine/wallet.js`)) {
  console.error(`No KaChat-Desktop checkout at ${desktop} - pass its path.`);
  process.exit(1);
}
let copied = 0;
const deleted = [];
// Only the files already here: the extension uses a subset of each folder. A new engine import
// needs its file copied in by hand once. Subfolders (engine/kachat-names) are walked too.
function sync(dir) {
  for (const entry of readdirSync(`${root}shared/${dir}`, { withFileTypes: true })) {
    if (entry.name === "README.md") continue;
    if (entry.isDirectory()) { sync(`${dir}/${entry.name}`); continue; }
    // a file KaChat-Desktop has since deleted: said at the end, the rest still synced (EXT-026) -
    // remove it here together with whatever imports it
    try {
      execFileSync("git", ["cat-file", "-e", `HEAD:${dir}/${entry.name}`], { cwd: desktop, stdio: "ignore" });
    } catch {
      deleted.push(`shared/${dir}/${entry.name}`);
      continue;
    }
    // the committed file, byte for byte (the WASM too)
    const committed = execFileSync("git", ["show", `HEAD:${dir}/${entry.name}`], { cwd: desktop, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(`${root}shared/${dir}/${entry.name}`, committed);
    copied += 1;
  }
}
for (const dir of ["engine", "ui", "kaspa"]) sync(dir);
const dirty = execFileSync("git", ["status", "--porcelain", "--", "engine", "ui/kspt.js", "ui/bip39-english.js", "ui/account-backup-status.js", "ui/account-import.js", "kaspa"], { cwd: desktop }).toString().trim();
if (dirty) console.log("note: KaChat-Desktop has uncommitted changes in synced folders - left out (copied from HEAD):\n" + dirty);
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: desktop }).toString().trim();
console.log(`copied ${copied} files from KaChat-Desktop ${commit}`);
if (deleted.length) console.log("deleted in KaChat-Desktop (left here - remove them and their imports):\n" + deleted.map((p) => `  ${p}`).join("\n"));
