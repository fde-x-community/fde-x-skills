// 契约漂移守卫（冷启动）：index / check / kb-scan / kb-apply 的产出必须都在 manifest.outputs 里声明。
// 平台会按 manifest.outputs 校验每一个 script 节点的产出；这类漂移会直接把 run 打成 failed。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCheck, runIndex, runKbApply, runKbScan } from '../scripts/run.mjs'

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'skill.manifest.json'), 'utf8'))
const OUT = manifest.outputs

function undeclaredKeys(value, schema, path = 'output') {
  const problems = []
  if (schema === undefined || value === null || typeof value !== 'object') return problems
  if (Array.isArray(value)) {
    if (schema.items !== undefined) for (const item of value) problems.push(...undeclaredKeys(item, schema.items, `${path}[]`))
    return problems
  }
  const props = schema.properties ?? {}
  const strict = schema.additionalProperties === false
  for (const key of Object.keys(value)) {
    const child = props[key]
    if (child === undefined) {
      if (strict) problems.push(`${path}.${key}: manifest.outputs 未声明，且该对象 additionalProperties=false`)
      continue
    }
    const nested = value[key]
    if (nested !== null && typeof nested === 'object') problems.push(...undeclaredKeys(nested, child, `${path}.${key}`))
  }
  for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${path}.${key}: 契约要求必填但产出缺失`)
  return problems
}

function assertContract(label, value) {
  const problems = undeclaredKeys(value, OUT, label)
  assert.deepEqual(problems, [], `${label} 与 manifest.outputs 不一致：\n${problems.join('\n')}`)
}

function makeFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'boot-contract-'))
  const transcript = join(root, 'S1.txt')
  writeFileSync(transcript, '[00:00:01] 发言人1：你好\n[00:00:05] 发言人2：想了解价格\n', 'utf8')
  const materials = join(root, 'material.md')
  writeFileSync(materials, '# 说明\n\n## 首诊\n先确认客户需求。\n', 'utf8')
  const draft = {
    industry_terms: ['首诊'],
    completion_words: [],
    required_question_topics: ['预算'],
    page: { notice: '内部草稿', footer: '仅供内部使用' },
  }
  return { root, transcript, materials, draft }
}

test('outputs.status 枚举完备（每个 script 阶段的 status 都在里面）', () => {
  const enumValues = OUT.properties.status.enum
  for (const status of ['index_only', 'drafted', 'needs_revision', 'kb_scanned', 'kb_applied']) {
    assert.ok(enumValues.includes(status), `outputs.status 缺少 ${status}`)
  }
})

test('index 阶段产出符合 manifest.outputs', () => {
  const { root, transcript } = makeFixtures()
  assertContract('index', runIndex({ transcripts: [{ session_id: 'S1', path: transcript }], out_dir: root }, SKILL_DIR))
})

test('check 阶段产出符合 manifest.outputs', () => {
  const { root, transcript, draft } = makeFixtures()
  assertContract('check', runCheck({ runInput: { transcripts: [{ session_id: 'S1', path: transcript }], out_dir: root }, draft, base: SKILL_DIR }))
})

test('kb-scan / kb-apply 产出符合 manifest.outputs（有材料）', () => {
  const { root, transcript, materials } = makeFixtures()
  const runInput = { transcripts: [{ session_id: 'S1', path: transcript }], out_dir: root, knowledge_base: materials }
  const scan = runKbScan(runInput, SKILL_DIR)
  assertContract('kb-scan', scan)
  assertContract('kb-apply', runKbApply({ runInput, plan: scan.suggested_plan, questions: ['示例问题'], base: SKILL_DIR }))
})

test('kb-scan / kb-apply 产出符合 manifest.outputs（无材料 → 显式空库）', () => {
  const { root, transcript } = makeFixtures()
  const runInput = { transcripts: [{ session_id: 'S1', path: transcript }], out_dir: root }
  assertContract('kb-scan(empty)', runKbScan(runInput, SKILL_DIR))
  assertContract('kb-apply(empty)', runKbApply({ runInput, base: SKILL_DIR }))
})
