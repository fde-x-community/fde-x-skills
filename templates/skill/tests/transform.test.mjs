// ${skill_name} 的可执行测试。零依赖,用 Node 内置的 node:test。
//
//   node scripts/test-all.mjs ${skill_name}
//
// 测试文件必须命名为 *.test.mjs,test-all.mjs 靠这个约定发现它们。
// 注意:场景矩阵里的 "status": "pass" 不构成证据。只有这里真的跑过、退出码为 0,
// 才算通过。测试必须能在干净环境里由非作者复现。

import { test } from "node:test";
import assert from "node:assert/strict";

import { transform } from "../scripts/transform.mjs";

test("golden: 正常输入产出 pass", () => {
  const out = transform({ raw_input: "  示例  " });
  assert.equal(out.status, "pass");
  assert.equal(out.result, "示例");
});

test("edge: 缺料时不猜测,标记 blocked", () => {
  // 对应 examples/edge/missing-input.json
  for (const bad of [{}, { raw_input: "" }, { raw_input: null }, undefined]) {
    assert.equal(transform(bad).status, "blocked");
  }
});

test("quality: 输出符合 schemas/output.schema.json 的必填字段", () => {
  const out = transform({ raw_input: "x" });
  assert.deepEqual(Object.keys(out).sort(), ["result", "status"]);
  assert.ok(["pass", "fail", "partial", "blocked", "not_run", "not_in_scope"].includes(out.status));
});
