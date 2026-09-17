#!/usr/bin/env node
// 跑 skills/ 下全部 skill 的测试。
//
//   node scripts/test-all.mjs                 # 全部
//   node scripts/test-all.mjs <skill-name>   # 指定一个
//
// 存在的理由:Node 24 上 `node --test <目录>` 会把目录当成模块入口报错,
// 而 glob 依赖 shell 展开、在 CI 上行为不一致。这里显式枚举测试文件再交给
// node --test,任何平台、任何 shell 下结果都一样。

import { readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");
const TEST_FILE_PATTERN = /\.test\.(mjs|cjs|js)$/;

function collectTestFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      collectTestFiles(full, out);
    } else if (TEST_FILE_PATTERN.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function main(argv) {
  const only = argv.find((a) => !a.startsWith("-"));

  if (!existsSync(SKILLS)) {
    console.log("skills/ 不存在,没有可跑的测试。");
    return 0;
  }

  const names = readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((n) => !only || n === only);

  if (only && names.length === 0) {
    console.error(`skills/${only} 不存在。`);
    return 1;
  }

  let total = 0;
  let failedSkills = [];

  for (const name of names) {
    const files = collectTestFiles(join(SKILLS, name, "tests"));
    if (files.length === 0) {
      console.log(`- ${name}: 没有测试文件,跳过`);
      continue;
    }
    total += files.length;
    const result = spawnSync(process.execPath, ["--test", ...files], {
      stdio: "inherit",
      cwd: ROOT,
    });
    if (result.status !== 0) failedSkills.push(name);
  }

  console.log("");
  if (total === 0) {
    console.log("没有找到任何测试文件。");
    return 0;
  }
  if (failedSkills.length) {
    console.error(`测试失败: ${failedSkills.join(", ")}`);
    return 1;
  }
  console.log(`全部测试通过(${names.length} 个 skill)。`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
