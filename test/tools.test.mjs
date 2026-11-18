/**
 * Both agent tools must register a JSON Schema object root. A bare property table
 * is forwarded verbatim to the model API, where a property named after a schema
 * keyword (title, description, enum, …) fails the whole turn with HTTP 400.
 * See 插件工具schema问题清单.md §一 and §三.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createImportTool, createPackBoxTool, createPackTool } from '../index.js'

/** The factories only use `transfer` inside execute, so a stub is enough here. */
const noop = () => {}

/**
 * Assert the shared shape: object root, a properties map, root-level required,
 * and no property-level `required` (the API reads it as `required: true`).
 * @param tool - Registered tool definition.
 */
function assertObjectRoot(tool) {
  assert.equal(tool.parameters.type, 'object', 'object root')
  assert.equal(typeof tool.parameters.properties, 'object', 'properties map')
  assert.equal(tool.parameters.action, undefined, 'no bare property table')
  for (const [name, schema] of Object.entries(tool.parameters.properties)) {
    assert.equal(schema.type.length > 0, true, `${name} declares one type`)
    assert.equal(Array.isArray(schema.type), false, `${name} type is not an array`)
    assert.equal(schema.required, undefined, `${name} must not carry property-level required`)
  }
}

test('pack_session schema is a JSON Schema object root', () => {
  const tool = createPackTool({}, noop)
  assert.equal(tool.name, 'pack_session')
  assertObjectRoot(tool)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['includeDescendants', 'path', 'sessionId'])
})

test('unpack_session schema is an object root with path required', () => {
  const tool = createImportTool({}, noop)
  assert.equal(tool.name, 'unpack_session')
  assertObjectRoot(tool)
  assert.deepEqual(tool.parameters.required, ['path'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['boxMode', 'dryRun', 'path', 'workspace'])
})

test('pack_box schema is an object root with box required', () => {
  const tool = createPackBoxTool({}, noop)
  assert.equal(tool.name, 'pack_box')
  assertObjectRoot(tool)
  assert.deepEqual(tool.parameters.required, ['box'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['box', 'includeDescendants', 'path'])
})
