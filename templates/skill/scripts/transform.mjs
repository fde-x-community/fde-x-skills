#!/usr/bin/env node
// ${skill_name} 的确定性逻辑。
//
// 凡是"每次都要重写一遍、且必须每次结果一致"的工作都应该放在这里,而不是让模型
// 每次重新生成。测试直接 import 这个模块,所以导出纯函数、不要在模块顶层执行副作用。
//
// 用法:
//   node scripts/transform.mjs < input.json > output.json

import { readFileSync } from "node:fs";

/**
 * 用真实的确定性逻辑替换这个函数体。
 *
 * @param {object} input - 符合 schemas/input.schema.json 的输入
 * @returns {{result: string, status: string}}
 */
export function transform(input) {
  const raw = input?.raw_input;
  if (typeof raw !== "string" || raw.length === 0) {
    // 缺料时不要猜。保留在分母里,并把状态如实标出来。
    return { result: "", status: "blocked" };
  }
  return { result: raw.trim(), status: "pass" };
}

// 只在作为命令行入口运行时读 stdin,被 import 时不执行。
if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = readFileSync(0, "utf8");
  process.stdout.write(`${JSON.stringify(transform(JSON.parse(raw)), null, 2)}\n`);
}
