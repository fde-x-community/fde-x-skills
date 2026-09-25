#!/usr/bin/env node
// fdex-skills 结构守门。
//
// 检查 strict_full anatomy 的结构完整性,不检查发布证据。
// 贡献者本地跑的和 CI 跑的是同一份代码:
//
//   node scripts/validate.mjs                 # 校验 skills/ 下全部
//   node scripts/validate.mjs --skill-dir skills/foo
//   node scripts/validate.mjs --json          # 机器可读输出
//
// 退出码:0 全部通过;1 有阻断项。
//
// 设计原则(来自 task-to-skill-loop 的 strict_full anatomy):
//   - VERSION.json / agents / schemas / 三类 examples / tests / logs 不可豁免
//   - 只有 references / scripts / assets 可走 anatomy-waivers.json 豁免
//   - 目录存在不等于完成:空目录、占位符、作者自写的 pass 都不算数
//   - 零依赖:只用 Node 内置模块,贡献者不需要 npm install

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, extname, sep } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- 常量

const SKILLS_DIR = "skills";
const TEMPLATES_DIR = "templates"; // 模板含占位符,不参与校验

const REQUIRED_DIRS = [
  "agents",
  "references",
  "schemas",
  "examples",
  "scripts",
  "tests",
  "logs",
  "assets",
];
const EXAMPLE_DIRS = ["golden", "edge", "failed"];
const NON_WAIVABLE = ["agents", "schemas", "examples", "tests", "logs"];
const WAIVABLE = ["references", "scripts", "assets"];
const WAIVER_REASON_BY_LAYER = {
  references: "self_contained_no_reference_responsibility",
  scripts: "instruction_only_no_deterministic_responsibility",
  assets: "no_reusable_asset_responsibility",
};
const WAIVER_APPROVER_ROLES = [
  "skill_owner",
  "domain_reviewer",
  "risk_approver",
  "release_control",
];

// VERSION.json 允许的成熟度。PR 默认只到 draft。
const ALLOWED_STATUS = ["draft", "package_validated", "operationally_validated"];
const STATUS_REQUIRING_EVIDENCE = ["package_validated", "operationally_validated"];

const EVAL_CATEGORIES = [
  "trigger",
  "non_trigger",
  "quality",
  "safety",
  "regression",
  "end_to_end",
];

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

const ALLOWED_FRONTMATTER_KEYS = ["name", "description"];

const BANNED_NAMES = new Set([
  ".env",
  "cookies.json",
  "cookie.json",
  "credentials.json",
  "secrets.json",
]);
const FORBIDDEN_CLUTTER = new Set([
  "readme.md",
  "changelog.md",
  "installation_guide.md",
  "quick_reference.md",
]);
const FORBIDDEN_ARCHIVES = new Set([".zip", ".rar", ".7z", ".tar", ".gz"]);

const TEXT_SUFFIXES = new Set([
  ".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".mjs", ".js",
  ".cjs", ".py", ".sh", ".ps1", ".csv", ".toml",
]);

// 占位符检测。最后一类 <中文> 是启发式:skill 包里出现尖括号裹中文基本就是没填。
const PLACEHOLDER_PATTERN = new RegExp(
  [
    String.raw`\bTODO\b`,
    String.raw`\bFIXME\b`,
    String.raw`\bTBD\b`,
    String.raw`\[PLACEHOLDER\]`,
    String.raw`Replace with the`,
    String.raw`Replace with a `,
    String.raw`<[^<>\n]*[一-龥][^<>\n]*>`,
  ].join("|"),
  "i",
);

// 凭证赋值:全文扫描
const CREDENTIAL_PATTERNS = [
  /(?<![A-Za-z0-9])(password|passwd|cookie|api[_-]?key|access[_-]?token|session[_-]?token|secret[_-]?key)(?![A-Za-z0-9])["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{8,}/i,
];
// 联系方式:只在 logs/ 扫描——真实日志不得泄漏
const LOG_PII_PATTERNS = [
  /\b1[3-9]\d{9}\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
];

// ---------------------------------------------------------------- 工具

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(root, p) {
  return relative(root, p).split(sep).join("/");
}

function isTextFile(p) {
  return TEXT_SUFFIXES.has(extname(p).toLowerCase());
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 本仓库只收录 name / description 两个顶层字段。
 * 这是仓库治理约束，比 Agent Skills 开放规范更严格。
 * 支持简单标量和块标量。
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { ok: false, error: "缺少 frontmatter(文件必须以下一行的 --- 开始)" };
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) return { ok: false, error: "frontmatter 未闭合(缺少结束的 ---)" };

  const fields = {};
  const unknown = [];
  let i = 1;
  while (i < end) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      // 缩进行只可能属于上面的块标量,走到这里说明格式坏了
      return { ok: false, error: `frontmatter 第 ${i + 1} 行无法解析: ${line.trim()}` };
    }
    const key = m[1];
    let value = m[2].trim();

    if (value === "|" || value === ">") {
      const block = [];
      i += 1;
      while (i < end && (lines[i].startsWith(" ") || lines[i].startsWith("\t"))) {
        block.push(lines[i].replace(/^\s{1,2}/, ""));
        i += 1;
      }
      value = block.join(value === "|" ? "\n" : " ").trim();
    } else {
      i += 1;
    }

    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    }

    if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) unknown.push(key);
    else fields[key] = value;
  }
  return { ok: true, fields, unknown };
}

// ---------------------------------------------------------------- 单项检查

function checkFrontmatter(skillDir, dirName, errors, warnings) {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    // 大小写敏感:GitHub 上大小写不匹配的 SKILL.md 会被静默忽略
    const entries = readdirSync(skillDir);
    const near = entries.find((e) => e.toLowerCase() === "skill.md");
    errors.push(
      near
        ? `缺少 SKILL.md(找到的是 "${near}",文件名大小写必须完全一致)`
        : "缺少 SKILL.md",
    );
    return null;
  }

  const parsed = parseFrontmatter(readFileSync(skillMd, "utf8"));
  if (!parsed.ok) {
    errors.push(`SKILL.md ${parsed.error}`);
    return null;
  }

  if (parsed.unknown.length) {
    errors.push(
        `SKILL.md frontmatter 含本仓库不收录的字段: ${parsed.unknown.join(", ")}。` +
        `本仓库只允许 ${ALLOWED_FRONTMATTER_KEYS.join(" / ")};` +
        `这是仓库规则，并非 Agent Skills 开放规范的限制。作者、版本等写进 VERSION.json`,
    );
  }

  const { name, description } = parsed.fields;

  if (!name) errors.push("SKILL.md frontmatter 缺少 name");
  else {
    if (name !== dirName) {
      errors.push(`frontmatter name "${name}" 与目录名 "${dirName}" 不一致`);
    }
    if (name.length > NAME_MAX) errors.push(`name 超过 ${NAME_MAX} 字符`);
    if (!NAME_PATTERN.test(name)) {
      errors.push(`name "${name}" 不是 kebab-case(只允许小写字母、数字、单个连字符分隔)`);
    }
  }

  if (!description) errors.push("SKILL.md frontmatter 缺少 description");
  else {
    if (description.length > DESCRIPTION_MAX) {
      errors.push(`description 超过 ${DESCRIPTION_MAX} 字符(当前 ${description.length})`);
    }
    if (description.trim().length < 20) {
      errors.push("description 太短。它是模型判断是否触发的唯一依据,写清\"做什么 + 什么时候用\"");
    }
  }
  return parsed.fields;
}

function checkVersionJson(skillDir, dirName, errors) {
  const p = join(skillDir, "VERSION.json");
  if (!existsSync(p)) {
    errors.push("缺少 VERSION.json(不可豁免)");
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    errors.push(`VERSION.json 不是合法 JSON: ${e.message}`);
    return null;
  }
  if (doc.skill_name !== dirName) {
    errors.push(`VERSION.json skill_name "${doc.skill_name}" 与目录名不一致`);
  }
  if (!doc.author) {
    errors.push("VERSION.json 缺少 author(署名,填 GitHub handle)");
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(doc.version ?? ""))) {
    errors.push(`VERSION.json version "${doc.version}" 不是 semver`);
  }
  if (!ALLOWED_STATUS.includes(doc.status)) {
    errors.push(
      `VERSION.json status "${doc.status}" 无效,允许: ${ALLOWED_STATUS.join(" / ")}`,
    );
  }
  if (STATUS_REQUIRING_EVIDENCE.includes(doc.status)) {
    // 作者自写的 pass 不构成证据——必须有可回读的外部证据文件
    const evidence = doc.validation?.release_evidence;
    if (!evidence) {
      errors.push(
        `status 为 "${doc.status}" 但 validation.release_evidence 为空。` +
          `未达该成熟度时请保留 draft——draft 是正常状态,不是失败`,
      );
    } else if (!existsSync(join(skillDir, evidence))) {
      errors.push(`validation.release_evidence 指向的文件不存在: ${evidence}`);
    }
  }
  return doc;
}

function checkAgents(skillDir, dirName, errors) {
  const p = join(skillDir, "agents", "openai.yaml");
  if (!existsSync(p)) {
    errors.push("缺少 agents/openai.yaml(不可豁免)");
    return;
  }
  const text = readFileSync(p, "utf8");
  for (const key of ["display_name", "short_description", "default_prompt"]) {
    if (!new RegExp(`^\\s*${key}\\s*:`, "m").test(text)) {
      errors.push(`agents/openai.yaml 缺少 ${key}`);
    }
  }
  if (!text.includes(`$${dirName}`)) {
    errors.push(`agents/openai.yaml 的 default_prompt 必须提及 $${dirName}`);
  }
}

function checkLayout(skillDir, waivers, errors) {
  for (const dir of REQUIRED_DIRS) {
    const waived = waivers.has(dir);
    const exists = existsSync(join(skillDir, dir));
    if (!exists) {
      if (!waived) {
        const hint = WAIVABLE.includes(dir)
          ? `(可由 anatomy-waivers.json 豁免,reason_code: ${WAIVER_REASON_BY_LAYER[dir]})`
          : "(不可豁免)";
        errors.push(`缺少目录 ${dir}/ ${hint}`);
      }
      continue;
    }
    if (waived) {
      errors.push(`目录 ${dir}/ 存在,但仍声明了豁免。请删除该豁免条目`);
    }
  }

  if (waivers.has("examples")) {
    errors.push("examples/ 不可豁免");
  }
  for (const ex of EXAMPLE_DIRS) {
    const dir = join(skillDir, "examples", ex);
    if (!existsSync(dir)) {
      errors.push(`缺少 examples/${ex}/`);
      continue;
    }
    const files = readdirSync(dir).filter((f) => !f.startsWith("."));
    if (files.length === 0) {
      errors.push(`examples/${ex}/ 为空。三类 example 都不可豁免`);
    }
  }

  // 场景矩阵只要求"六类都声明到"(结构),不要求它们通过(证据)。
  const matrix = join(skillDir, "tests", "scenario-matrix.json");
  if (existsSync(matrix)) {
    try {
      const doc = JSON.parse(readFileSync(matrix, "utf8"));
      if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
        errors.push("tests/scenario-matrix.json 的 cases 为空,至少每类一个场景");
      } else {
        const covered = new Set(doc.cases.map((c) => c?.category));
        const missing = EVAL_CATEGORIES.filter((c) => !covered.has(c));
        if (missing.length) {
          errors.push(
            `tests/scenario-matrix.json 未覆盖评估类别: ${missing.join(", ")}` +
              `(必需: ${EVAL_CATEGORIES.join(", ")})`,
          );
        }
      }
    } catch (e) {
      errors.push(`tests/scenario-matrix.json 不是合法 JSON: ${e.message}`);
    }
  } else if (existsSync(join(skillDir, "tests"))) {
    errors.push("缺少 tests/scenario-matrix.json");
  }

  const logDir = join(skillDir, "logs");
  if (existsSync(logDir)) {
    const names = readdirSync(logDir);
    if (!names.some((n) => n.toLowerCase().endsWith(".md"))) {
      errors.push("logs/ 缺少日志契约文档(见 templates/skill/logs/log-contract.md)");
    }
    if (names.length < 2) {
      errors.push("logs/ 需要日志契约 + 合成模板,当前只有一个文件");
    }
  }
}

function checkWaivers(skillDir, errors) {
  const p = join(skillDir, "anatomy-waivers.json");
  const waived = new Set();
  if (!existsSync(p)) return waived;

  let doc;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    errors.push(`anatomy-waivers.json 不是合法 JSON: ${e.message}`);
    return waived;
  }
  if (doc.profile !== "strict_full") {
    errors.push(`anatomy-waivers.json profile 必须是 "strict_full"`);
  }
  const list = Array.isArray(doc.waivers) ? doc.waivers : [];
  for (const w of list) {
    const layer = w.layer;
    if (!WAIVABLE.includes(layer)) {
      errors.push(
        `anatomy-waivers.json 试图豁免 "${layer}",但只有 ${WAIVABLE.join(" / ")} 可豁免`,
      );
      continue;
    }
    if (w.reason_code !== WAIVER_REASON_BY_LAYER[layer]) {
      errors.push(
        `豁免 ${layer} 的 reason_code 必须是 "${WAIVER_REASON_BY_LAYER[layer]}"`,
      );
    }
    if (!w.replacement_evidence?.length) {
      errors.push(`豁免 ${layer} 必须提供 replacement_evidence`);
    }
    if (!w.requester || !w.approver) {
      errors.push(`豁免 ${layer} 必须同时记录 requester 和 approver`);
    } else if (w.requester === w.approver) {
      errors.push(`豁免 ${layer} 的 approver 必须与 requester 不同——不能自批`);
    }
    if (w.approver && !WAIVER_APPROVER_ROLES.includes(w.approver_role)) {
      errors.push(
        `豁免 ${layer} 的 approver_role 无效,允许: ${WAIVER_APPROVER_ROLES.join(" / ")}`,
      );
    }
    if (!w.expiry && !w.reconsider_trigger) {
      errors.push(`豁免 ${layer} 必须有 expiry 或 reconsider_trigger`);
    }
    waived.add(layer);
  }
  return waived;
}

/**
 * 递归找出空目录。目录存在不等于完成——空目录不满足 anatomy,
 * 嵌套的空目录同样不算数。
 */
function checkEmptyDirs(skillDir, errors) {
  const stack = [skillDir];
  while (stack.length) {
    const dir = stack.pop();
    const entries = readdirSync(dir, { withFileTypes: true });
    if (dir !== skillDir && entries.length === 0) {
      errors.push(`${rel(skillDir, dir)}/: 空目录。空目录不满足 anatomy——放真实内容或走豁免`);
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(dir, e.name));
    }
  }
}

function checkFileHygiene(skillDir, errors) {
  for (const file of walk(skillDir)) {
    const name = basename(file).toLowerCase();
    const path = rel(skillDir, file);

    if (BANNED_NAMES.has(name)) {
      errors.push(`禁止提交凭证类文件: ${path}`);
    }
    if (FORBIDDEN_CLUTTER.has(name)) {
      errors.push(
        `${path}: skill 包内禁止 ${basename(file)}——面向人的文档请放进 references/`,
      );
    }
    if (FORBIDDEN_ARCHIVES.has(extname(name))) {
      errors.push(`${path}: skill 包内禁止压缩包,请提交解压后的内容`);
    }
    if (!isTextFile(file)) continue;

    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // assets/ 按定义就是待填充的产出模板,不适用占位符检查。
    if (!path.startsWith("assets/") && PLACEHOLDER_PATTERN.test(text)) {
      errors.push(`${path}: 含占位符(TODO/FIXME/TBD/待替换文字)。占位符不满足 anatomy`);
    }
    for (const re of CREDENTIAL_PATTERNS) {
      if (re.test(text)) {
        errors.push(`${path}: 疑似硬编码凭证`);
        break;
      }
    }
    if (path.startsWith("logs/")) {
      for (const re of LOG_PII_PATTERNS) {
        if (re.test(text)) {
          errors.push(`${path}: 日志中出现手机号或邮箱,真实日志不得进包`);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 主流程

export function validateSkill(skillDir, dirName) {
  const errors = [];
  const warnings = [];

  const frontmatter = checkFrontmatter(skillDir, dirName, errors, warnings);
  const version = checkVersionJson(skillDir, dirName, errors);
  const waivers = checkWaivers(skillDir, errors);
  checkAgents(skillDir, dirName, errors);
  checkLayout(skillDir, waivers, errors);
  checkEmptyDirs(skillDir, errors);
  checkFileHygiene(skillDir, errors);

  return {
    name: dirName,
    errors,
    warnings,
    status: version?.status ?? null,
    description: frontmatter?.description ?? null,
    maturity: version?.artifact_maturity ?? null,
  };
}

export function discoverSkills(root = process.cwd()) {
  const base = join(root, SKILLS_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== TEMPLATES_DIR)
    .map((e) => ({ dir: join(base, e.name), name: e.name }));
}

function main(argv) {
  const asJson = argv.includes("--json");
  const dirFlag = argv.indexOf("--skill-dir");
  const root = process.cwd();

  let targets;
  if (dirFlag !== -1) {
    const dir = argv[dirFlag + 1];
    if (!dir) {
      console.error("--skill-dir 需要一个路径");
      return 2;
    }
    targets = [{ dir, name: basename(dir) }];
  } else {
    targets = discoverSkills(root);
  }

  if (targets.length === 0) {
    if (asJson) console.log(JSON.stringify({ skills: [], ok: true }, null, 2));
    else console.log("skills/ 下没有找到任何 skill；当前只完成工具链检查，尚未验证 Skill 包。");
    return 0;
  }

  const results = targets.map((t) => validateSkill(t.dir, t.name));
  const failed = results.filter((r) => r.errors.length > 0);

  if (asJson) {
    console.log(JSON.stringify({ skills: results, ok: failed.length === 0 }, null, 2));
  } else {
    for (const r of results) {
      if (r.errors.length === 0) {
        console.log(`✓ ${r.name}  [${r.status ?? "?"}]`);
        continue;
      }
      console.log(`✗ ${r.name}`);
      for (const e of r.errors) console.log(`    ${e}`);
    }
    console.log("");
    if (failed.length === 0) {
      console.log(`${results.length} 个 skill 全部通过结构校验。`);
    } else {
      console.log(`${failed.length}/${results.length} 个 skill 未通过。修正上面每一项后重跑。`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
