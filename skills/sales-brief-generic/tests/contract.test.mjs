// 契约漂移守卫：把每个 script 阶段**真实产出**的 key 与 manifest.outputs 声明逐一比对。
// 背景：平台会按 manifest.outputs 校验每一个 script 节点的产出，字段漂移会直接把 run 打成 failed。
// 这个用例就是把「跑一遍 + 对契约」固化成回归。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { planIndexes, runFinalize, runIndex, runRender } from '../scripts/run.mjs'

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'skill.manifest.json'), 'utf8'))
const OUT = manifest.outputs
const TRANSCRIPT = join(SKILL_DIR, 'examples', 'fixtures', 'synthetic.txt')
const MINI_KB = join(SKILL_DIR, 'examples', 'fixtures', 'mini-kb')

function undeclaredKeys(value, schema, path = 'output') {
  const problems = []
  if (schema === undefined || value === null || typeof value !== 'object') return problems
  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      for (const item of value) problems.push(...undeclaredKeys(item, schema.items, `${path}[]`))
    }
    return problems
  }
  // 只有 additionalProperties === false（或显式列了 properties 且为 false）时，平台才会拒收未知字段；
  // additionalProperties 为 true / 未声明时按「允许扩展」处理，不报漂移。
  const props = schema.properties ?? {}
  const strict = schema.additionalProperties === false
  for (const key of Object.keys(value)) {
    const child = props[key]
    if (child === undefined) {
      if (strict) problems.push(`${path}.${key}: manifest.outputs 未声明，且该对象 additionalProperties=false（平台会判 failed）`)
      continue
    }
    const nested = value[key]
    if (nested !== null && typeof nested === 'object') problems.push(...undeclaredKeys(nested, child, `${path}.${key}`))
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) problems.push(`${path}.${key}: 契约要求必填但产出缺失`)
  }
  return problems
}

function assertContract(label, value) {
  const problems = undeclaredKeys(value, OUT, label)
  assert.deepEqual(problems, [], `${label} 与 manifest.outputs 不一致：\n${problems.join('\n')}`)
}

function kbRunInput() {
  const outDir = mkdtempSync(join(tmpdir(), 'contract-'))
  return { transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir, knowledge_base_dir: MINI_KB, case_id: 'SYN-01' }
}

function analysisFor(runInput) {
  const analysis = JSON.parse(readFileSync(join(SKILL_DIR, 'examples', 'fixtures', 'analysis-kb.json'), 'utf8'))
  const plan = planIndexes(runInput, SKILL_DIR)
  analysis.case_id = runInput.case_id
  analysis.input_binding = {
    kb_fingerprint: plan.kb.fingerprint.slice(0, 16),
    transcripts: Object.fromEntries(plan.indexes.map((index) => [index.session_id, index.sha256])),
  }
  return analysis
}

test('outputs.status 必须是带枚举的字段，且 required 含 status/execution_status', () => {
  assert.ok(OUT.properties?.status?.enum?.length > 0, 'outputs.status 必须有枚举')
  assert.ok(OUT.required.includes('status') && OUT.required.includes('execution_status'), 'outputs.required 至少含 status 与 execution_status')
})

test('index 阶段产出符合 manifest.outputs（含知识库字段）', () => {
  const runInput = kbRunInput()
  assertContract('index', runIndex(runInput, SKILL_DIR))
})

test('render 阶段产出符合 manifest.outputs（含 kb_report）', () => {
  const runInput = kbRunInput()
  const output = runRender({ runInput, submission: { analysis: analysisFor(runInput) }, base: SKILL_DIR })
  assertContract('render', output)
})

test('finalize 阶段产出符合 manifest.outputs', () => {
  const runInput = kbRunInput()
  const first = runRender({ runInput, submission: { analysis: analysisFor(runInput) }, base: SKILL_DIR })
  assert.ok(first.h5.length > 0)
  const output = runFinalize({ runInput, polish: { status: 'nothing_to_fix', fixed: [], residual: [] }, base: SKILL_DIR })
  assertContract('finalize', output)
})

test('未接入知识库时各阶段产出同样符合契约', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'contract-nokb-'))
  const runInput = { transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir }
  assertContract('index(nokb)', runIndex(runInput, SKILL_DIR))
  const analysis = JSON.parse(readFileSync(join(SKILL_DIR, 'examples', 'fixtures', 'analysis.json'), 'utf8'))
  assertContract('render(nokb)', runRender({ runInput, submission: { analysis }, base: SKILL_DIR }))
  assertContract('finalize(nokb)', runFinalize({ runInput, polish: { status: 'nothing_to_fix', fixed: [], residual: [] }, base: SKILL_DIR }))
})
