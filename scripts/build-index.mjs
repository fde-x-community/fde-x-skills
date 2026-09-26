#!/usr/bin/env node
// 从 skills/*/VERSION.json 和 SKILL.md 生成 README 里的 skill 索引。
//
//   node scripts/build-index.mjs            # 写回 README.md
//   node scripts/build-index.mjs --check    # 只检查是否漂移(CI 用)
//
// 贡献者不要手改 README 的索引表——CI 会跑 --check,漂移就阻断。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverSkills, parseFrontmatter } from "./validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");

const START = "<!-- SKILLS:START -->";
const END = "<!-- SKILLS:END -->";

function frontmatterOf(skillDir) {
  const p = join(skillDir, "SKILL.md");
  if (!existsSync(p)) return null;
  const parsed = parseFrontmatter(readFileSync(p, "utf8"));
  return parsed.ok ? parsed.fields : null;
}

function versionOf(skillDir) {
  const p = join(skillDir, "VERSION.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function cell(text, max = 140) {
  const flat = String(text ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderTable(root = ROOT) {
  const skills = discoverSkills(root)
    .map(({ dir, name }) => {
      const fm = frontmatterOf(dir);
      const version = versionOf(dir);
      return {
        name,
        description: fm?.description ?? "",
        version: version?.version ?? "—",
        status: version?.status ?? "unknown",
        author: version?.author || version?.metadata?.author || "—",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (skills.length === 0) {
    return "_这里收录从真实企业任务中提炼的 Skill,欢迎从一个真实企业需求开始贡献_";
  }

  const lines = [
    "| Skill | 说明 | 版本 | 成熟度 | 作者 |",
    "|---|---|---|---|---|",
    ...skills.map(
      (s) =>
        `| [\`${s.name}\`](skills/${s.name}/) | ${cell(s.description)} | ${s.version} | ${s.status} | ${cell(s.author, 40)} |`,
    ),
  ];
  return lines.join("\n");
}

function main(argv) {
  const check = argv.includes("--check");
  const table = renderTable();
  const startMarker = `${START}\n`;
  const endMarker = `\n${END}`;
  const block = `${startMarker}${table}${endMarker}`;

  const readme = readFileSync(README, "utf8");
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s === -1 || e === -1) {
    console.error(`README.md 缺少 ${START} / ${END} 标记。`);
    return 1;
  }

  const updated = readme.slice(0, s) + block + readme.slice(e + END.length);

  if (check) {
    if (updated !== readme) {
      console.error("README.md 的 skill 索引已漂移。请运行: node scripts/build-index.mjs");
      return 1;
    }
    console.log("README 索引与 skills/ 一致。");
    return 0;
  }

  if (updated === readme) {
    console.log("README 索引已是最新,无需改动。");
    return 0;
  }
  writeFileSync(README, updated);
  console.log("已更新 README.md 的 skill 索引。");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
