/**
 * publish-shards.mjs
 *
 * Creates (if needed) and pushes the shard repos produced by
 * `mirror-shop.mjs zips`. Each shard becomes `pets-shop-copy-<n>` on Gitee.
 *
 * Usage
 *   GITEE_TOKEN=<token> node scripts/publish-shards.mjs <shardRoot> [--owner nixer] [--base pets-shop-copy] [--branch master]
 *
 * The token is read from the environment and only ever used inside this
 * process (API header + push URL). It is never written to disk or to a repo's
 * git config, and never appears on a command line.
 */

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const shardRoot = process.argv[2];
const args = process.argv.slice(3);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const owner = flag("owner", process.env.GITEE_OWNER ?? "nixer");
const token = process.env.GITEE_TOKEN ?? "";
const base = flag("base", "pets-shop-copy");
const branch = flag("branch", "master");

if (!shardRoot || token.length === 0) {
  console.error("usage: GITEE_TOKEN=<token> node scripts/publish-shards.mjs <shardRoot> [--owner nixer]");
  process.exit(2);
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function makePublic(name) {
  // Gitee's create endpoint ignores `private: false` on some accounts and the
  // repo stays private, which makes every raw URL 403. Force it public.
  const patch = await fetch(`https://gitee.com/api/v5/repos/${owner}/${name}`, {
    method: "PATCH",
    headers: { authorization: `token ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, path: name, private: false }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!patch.ok) throw new Error(`repo make-public ${name} failed: HTTP ${patch.status} ${await patch.text()}`);
}

async function ensureRepo(name) {
  const check = await fetch(`https://gitee.com/api/v5/repos/${owner}/${name}`, {
    headers: { authorization: `token ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (check.ok) {
    await makePublic(name);
    return "exists (public)";
  }
  if (check.status !== 404) throw new Error(`repo check failed: HTTP ${check.status}`);
  const response = await fetch("https://gitee.com/api/v5/user/repos", {
    method: "POST",
    headers: { authorization: `token ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name,
      description: `OpenPets shop mirror shard (${name})`,
      private: false,
      auto_init: false,
      has_issues: false,
      has_wiki: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`repo create ${name} failed: HTTP ${response.status} ${await response.text()}`);
  await makePublic(name);
  return "created (public)";
}

const map = JSON.parse(await readFile(join(shardRoot, "map.json"), "utf8"));
const shardCount = map.shards ?? 0;
console.log(`[publish] ${shardCount} shards, ${(map.totalBytes / 1024 / 1024).toFixed(1)} MiB total`);

for (let shard = 0; shard < shardCount; shard += 1) {
  const dir = join(shardRoot, `shard-${shard}`);
  const name = `${base}-${shard}`;
  const files = await readdir(dir, { recursive: true });
  console.log(`[publish] shard ${shard}: ${files.length} entries -> ${name}`);
  const state = await ensureRepo(name);
  console.log(`  repo ${state}`);

  run("git", ["init", "-b", branch], dir);
  run("git", ["add", "-A"], dir);
  run("git", ["-c", "user.name=nixer", "-c", "user.email=nixer456@163.com", "commit", "-m", `feat: shop mirror shard ${shard}`], dir);
  const push = run("git", ["push", `https://${owner}:${token}@gitee.com/${owner}/${name}.git`, branch], dir);
  console.log(`  push: ${push.trim().split("\n").pop()}`);
}

console.log("[publish] done");
