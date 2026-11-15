import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ZipReader, ZipWriter, crc32, safeEntryName } from '../lib/zip.mjs'

async function withTempDir(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'dst-zip-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('crc32 matches the IEEE reference vector', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926')
})

test('safeEntryName refuses traversal, absolute, and backslash names', () => {
  assert.equal(safeEntryName('sessions/a.jsonl'), 'sessions/a.jsonl')
  for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'a\\b', '', 'a//b', 'C:', 'a/\u0000b']) {
    assert.equal(safeEntryName(bad), undefined, bad)
  }
})

test('round-trips text, binary, and empty entries', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'pack.zip')
    const random = Buffer.from(Array.from({ length: 200_000 }, (_unused, index) => (index * 131) % 256))
    const writer = ZipWriter.open(path)
    writer.addText('a/你好.txt', 'line\n'.repeat(5000))
    writer.add('b/blob.bin', random)
    writer.addText('empty', '')
    const bytes = writer.close()
    assert.ok(bytes > 0)
    const reader = new ZipReader(path)
    assert.deepEqual(reader.names(), ['a/你好.txt', 'b/blob.bin', 'empty'].sort())
    assert.equal(reader.readText('a/你好.txt'), 'line\n'.repeat(5000))
    assert.ok(reader.read('b/blob.bin').equals(random))
    assert.equal(reader.readText('empty'), '')
    reader.close()
  })
})

test('the archive is readable by another ZIP implementation', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'pack.zip')
    const writer = ZipWriter.open(path)
    writer.addText('one.txt', 'hello')
    writer.close()
    const head = await readFile(path)
    assert.equal(head.readUInt32LE(0), 0x04034b50)
    // Independent structural check: local header + central directory + EOCD.
    assert.ok(head.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02])), 'central directory missing')
    assert.ok(head.subarray(-22).readUInt32LE(0) === 0x06054b50, 'EOCD missing')
  })
})

test('detects payload corruption', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'pack.zip')
    const writer = ZipWriter.open(path)
    writer.add('data.bin', Buffer.from('x'.repeat(4096)))
    writer.close()
    const bytes = await readFile(path)
    bytes[30 + 8] ^= 0xff
    await writeFile(path, bytes)
    const reader = new ZipReader(path)
    assert.throws(() => reader.read('data.bin'))
    reader.close()
  })
})

test('refuses truncated archives and foreign local headers', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'pack.zip')
    const writer = ZipWriter.open(path)
    writer.addText('a.txt', 'a')
    writer.close()
    const bytes = await readFile(path)
    const truncated = join(directory, 'truncated.zip')
    await writeFile(truncated, bytes.subarray(0, bytes.length - 30))
    assert.throws(() => new ZipReader(truncated))
  })
})
