#!/usr/bin/env node
// 从 templates/skill 生成一个 strict_full 骨架。
//
//   node scripts/new-skill.mjs <kebab-case-name> --author <github-handle>
//
// 生成后骨架里全是待替换文字,validate.mjs 会一直报错直到你填完——这是刻意的。
// 填空的过程就是把责任契约想清楚的过程。

import { cpSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "skill");
const SKILLS = join(ROOT, "skills");

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function main(argv) {
  const name = argv.find((a) => !a.startsWith("--") && a !== argv[argv.indexOf("--author") + 1]);
  const authorIdx = argv.indexOf("--author");
  const author = authorIdx !== -1 ? argv[authorIdx + 1] : "";

  if (!name) {
    console.error("用法: node scripts/new-skill.mjs <kebab-case-name> --author <github-handle>");
    return 2;
  }
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    console.error(
      `"${name}" 不是合法的 skill 名。只允许小写字母、数字和单个连字符分隔,最长 64 字符。`,
    );
    return 2;
  }

  const target = join(SKILLS, name);
  if (existsSync(target)) {
    console.error(`skills/${name} 已存在,不覆盖。`);
    return 1;
  }

  cpSync(TEMPLATE, target, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const values = {
    "${skill_name}": name,
    "${display_name}": name,
    "${short_description}": `待填写:${name} 的短描述`,
    "${description}": `待填写:${name} 做什么,以及什么时候使用它。`,
    "${author}": author,
    "${created_date}": today,
  };

  let touched = 0;
  for (const file of walkFiles(target)) {
    const before = readFileSync(file, "utf8");
    let after = before;
    for (const [k, v] of Object.entries(values)) after = after.split(k).join(v);
    if (after !== before) {
      writeFileSync(file, after);
      touched += 1;
    }
  }

  console.log(`已生成 skills/${name}/ (${touched} 个文件已替换占位符)`);
  console.log("");
  console.log("接下来:");
  console.log("  1. 填 skills/" + name + "/SKILL.md 的 description —— 它是触发的唯一依据");
  console.log("  2. 按责任契约填 references/ schemas/ examples/ scripts/ tests/ logs/ assets/");
  console.log("  3. node scripts/validate.mjs --skill-dir skills/" + name);
  console.log("  4. node scripts/test-all.mjs " + name + " && node scripts/build-index.mjs");
  console.log("");
  console.log("注意:VERSION.json 的 status 保持 draft 即可。draft 是正常状态,不是失败。");
  return 0;
}

process.exit(main(process.argv.slice(2)));
