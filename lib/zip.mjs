/**
 * Minimal, dependency-free ZIP writer and reader.
 *
 * The session-transfer pack is a plain ZIP archive so a user can rename it to
 * `.zip`, inspect it with any archive tool, and still import it. This module
 * implements only the subset the pack needs: UTF-8 names, stored or deflated
 * entries, one disk, no ZIP64, no encryption. Every read validates the central
 * directory, entry names, sizes, and CRC before handing bytes back.
 *
 * @module dsh-session-transfer/zip
 */
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** Local file header signature. */
const LOCAL_SIGNATURE = 0x04034b50
/** Central directory header signature. */
const CENTRAL_SIGNATURE = 0x02014b50
/** End of central directory signature. */
const EOCD_SIGNATURE = 0x06054b50
/** ZIP64 end of central directory locator signature. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
/** General-purpose flag: entry name is UTF-8. */
const FLAG_UTF8 = 0x0800
/** General-purpose flag: sizes follow the data in a descriptor (unsupported on read). */
const FLAG_DESCRIPTOR = 0x0008
/** Compression method: stored. */
const METHOD_STORE = 0
/** Compression method: deflate. */
const METHOD_DEFLATE = 8
/** Version needed to extract: 2.0. */
const VERSION = 20
/** Largest archive the reader accepts. */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024 - 1
/** Largest number of entries the reader accepts. */
export const MAX_ENTRIES = 65535
/** Largest single entry the reader accepts. */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024
/** Largest central directory the reader accepts. */
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024
/** DOS timestamp base: 1980-01-01 00:00:00 local. */
const DOS_EPOCH = Date.UTC(1980, 0, 1, 0, 0, 0)

/** CRC-32 lookup table (IEEE polynomial, reflected). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * Compute the CRC-32 of one buffer.
 * @param buffer - bytes to checksum.
 * @param seed - running checksum from a previous chunk (default: none).
 * @returns the unsigned 32-bit checksum.
 */
export function crc32(buffer, seed = 0) {
  let value = (seed ^ 0xffffffff) >>> 0
  for (let index = 0; index < buffer.length; index += 1) value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** DOS date/time pair for one instant. */
function dosTimeOf(date) {
  const year = Math.max(1980, date.getFullYear())
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosClock = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  return { dosDate: dosDate & 0xffff, dosClock: dosClock & 0xffff }
}

/** A ZIP entry name that cannot escape extraction or collide with a directory. */
export function safeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024) return undefined
  if (name.includes('\u0000') || name.includes('\\')) return undefined
  if (name.startsWith('/')) return undefined
  const parts = name.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return undefined
    if (/^[A-Za-z]:$/.test(part)) return undefined
  }
  return name
}

/**
 * Build one ZIP archive at a filesystem path.
 *
 * Entries are written in call order; each `add` buffers only its own deflated
 * bytes, so peak memory is the largest single entry rather than the archive.
 */
export class ZipWriter {
  /**
   * @param fd - open writable file descriptor positioned at the archive start.
   * @param startedAt - archive timestamp applied to every entry.
   */
  constructor(fd, startedAt) {
    this.fd = fd
    this.time = dosTimeOf(startedAt)
    this.offset = 0
    this.records = []
    this.closed = false
  }

  /**
   * Open one archive for writing (truncates an existing file).
   * @param path - destination archive path.
   * @param options - optional timestamp override.
   * @returns the writer.
   */
  static open(path, options = {}) {
    const fd = openSync(path, 'w')
    return new ZipWriter(fd, options.startedAt ?? new Date())
  }

  /** Write one buffer without buffering the whole archive. */
  write(buffer) {
    let written = 0
    while (written < buffer.length) written += writeSync(this.fd, buffer, written, buffer.length - written)
    this.offset += buffer.length
  }

  /**
   * Append one entry.
   * @param name - archive path; rejected when unsafe.
   * @param data - entry bytes.
   * @returns the stored entry metadata.
   */
  add(name, data) {
    if (this.closed) throw new Error('zip: writer is closed')
    const entryName = safeEntryName(name)
    if (entryName === undefined) throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`)
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (raw.length > MAX_ENTRY_BYTES) throw new Error(`zip: entry ${name} exceeds ${MAX_ENTRY_BYTES} bytes`)
    if (this.records.length >= MAX_ENTRIES) throw new Error(`zip: more than ${MAX_ENTRIES} entries`)
    const deflated = deflateRawSync(raw, { level: 6 })
    const useDeflate = deflated.length < raw.length
    const stored = useDeflate ? deflated : raw
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE
    const nameBytes = Buffer.from(entryName, 'utf8')
    const crc = crc32(raw)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_SIGNATURE, 0)
    header.writeUInt16LE(VERSION, 4)
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(this.time.dosClock, 10)
    header.writeUInt16LE(this.time.dosDate, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(stored.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    const localOffset = this.offset
    this.write(header)
    this.write(nameBytes)
    this.write(stored)
    this.records.push({
      name: nameBytes,
      method,
      crc,
      compressed: stored.length,
      uncompressed: raw.length,
      localOffset,
    })
    return { name: entryName, bytes: raw.length, stored: stored.length, method }
  }

  /** Append one UTF-8 text entry. */
  addText(name, text) {
    return this.add(name, Buffer.from(text, 'utf8'))
  }

  /**
   * Finish the archive with its central directory.
   * @returns the final archive byte count.
   */
  close() {
    if (this.closed) return this.offset
    this.closed = true
    const centralStart = this.offset
    for (const record of this.records) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(CENTRAL_SIGNATURE, 0)
      header.writeUInt16LE(VERSION, 4)
      header.writeUInt16LE(VERSION, 6)
      header.writeUInt16LE(FLAG_UTF8, 8)
      header.writeUInt16LE(record.method, 10)
      header.writeUInt16LE(this.time.dosClock, 12)
      header.writeUInt16LE(this.time.dosDate, 14)
      header.writeUInt32LE(record.crc, 16)
      header.writeUInt32LE(record.compressed, 20)
      header.writeUInt32LE(record.uncompressed, 24)
      header.writeUInt16LE(record.name.length, 28)
      header.writeUInt16LE(0, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      header.writeUInt32LE(0, 38)
      header.writeUInt32LE(record.localOffset, 42)
      this.write(header)
      this.write(record.name)
    }
    const centralSize = this.offset - centralStart
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.records.length, 8)
    eocd.writeUInt16LE(this.records.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralStart, 16)
    eocd.writeUInt16LE(0, 20)
    this.write(eocd)
    closeSync(this.fd)
    return this.offset
  }

  /** Abort the archive and remove the partial file from the caller's side. */
  abort() {
    if (this.closed) return
    this.closed = true
    try {
      closeSync(this.fd)
    } catch {
      /* the descriptor is already gone */
    }
  }
}

/** Read exactly `length` bytes at `position`, or throw a corruption error. */
function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const chunk = readSync(fd, buffer, read, length - read, position + read)
    if (chunk === 0) throw new Error('zip: unexpected end of archive')
    read += chunk
  }
  return buffer
}

/**
 * Read one ZIP archive by path with random access.
 *
 * The central directory is parsed once at construction; entry bytes are read
 * on demand. Archives using ZIP64, encryption, data descriptors, or an unknown
 * compression method are refused rather than guessed at.
 */
export class ZipReader {
  /**
   * @param path - archive path.
   * @param options - optional entry-count and per-entry byte caps.
   */
  constructor(path, options = {}) {
    this.path = path
    this.fd = openSync(path, 'r')
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES
    this.maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES
    this.size = statSync(path).size
    if (this.size > MAX_ARCHIVE_BYTES) throw new Error('zip: archive is too large')
    this.entries = new Map()
    try {
      this.#parse()
    } catch (error) {
      this.close()
      throw error
    }
  }

  /** Locate and parse the end-of-central-directory record and central directory. */
  #parse() {
    if (this.size < 22) throw new Error('zip: file is too small to be a ZIP archive')
    const tailLength = Math.min(this.size, 22 + 65535 + 20)
    const tailStart = this.size - tailLength
    const tail = readExact(this.fd, tailLength, tailStart)
    let eocd = -1
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue
      const commentLength = tail.readUInt16LE(index + 20)
      if (index + 22 + commentLength === tail.length) {
        eocd = index
        break
      }
    }
    if (eocd < 0) throw new Error('zip: end of central directory not found')
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) throw new Error('zip: ZIP64 archives are not supported')
    const entryCount = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (entryCount > this.maxEntries) throw new Error(`zip: more than ${this.maxEntries} entries`)
    if (centralSize > MAX_CENTRAL_BYTES) throw new Error('zip: central directory is too large')
    if (centralOffset + centralSize > this.size) throw new Error('zip: central directory points past the end of the file')
    const central = readExact(this.fd, centralSize, centralOffset)
    let cursor = 0
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length) throw new Error('zip: truncated central directory')
      if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('zip: bad central directory signature')
      const entryStart = cursor
      const flags = central.readUInt16LE(entryStart + 8)
      const method = central.readUInt16LE(entryStart + 10)
      const crc = central.readUInt32LE(entryStart + 16)
      const compressedSize = central.readUInt32LE(entryStart + 20)
      const uncompressedSize = central.readUInt32LE(entryStart + 24)
      const nameLength = central.readUInt16LE(entryStart + 28)
      const extraLength = central.readUInt16LE(entryStart + 30)
      const commentLength = central.readUInt16LE(entryStart + 32)
      const localOffset = central.readUInt32LE(entryStart + 42)
      cursor = entryStart + 46 + nameLength + extraLength + commentLength
      if (cursor > central.length) throw new Error('zip: truncated central directory entry')
      const name = central.toString('utf8', entryStart + 46, entryStart + 46 + nameLength)
      if (safeEntryName(name) === undefined) throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`)
      if ((flags & FLAG_DESCRIPTOR) !== 0) throw new Error(`zip: entry ${name} uses an unsupported data descriptor`)
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new Error(`zip: entry ${name} uses unsupported compression method ${method}`)
      if (uncompressedSize > this.maxEntryBytes) throw new Error(`zip: entry ${name} exceeds the ${this.maxEntryBytes} byte cap`)
      if (compressedSize > this.size) throw new Error(`zip: entry ${name} is larger than the archive`)
      if (this.entries.has(name)) throw new Error(`zip: duplicate entry ${name}`)
      this.entries.set(name, { name, method, crc, compressedSize, uncompressedSize, localOffset })
    }
  }

  /** Sorted entry names, for diagnostics. */
  names() {
    return [...this.entries.keys()].sort()
  }

  /** Whether the archive contains one entry. */
  has(name) {
    return this.entries.has(name)
  }

  /**
   * Read and verify one entry.
   * @param name - exact archive path.
   * @returns the entry bytes.
   */
  read(name) {
    const entry = this.entries.get(name)
    if (entry === undefined) throw new Error(`zip: entry ${name} is missing`)
    if (entry.localOffset + 30 > this.size) throw new Error(`zip: entry ${name} has a bad local header offset`)
    const local = readExact(this.fd, 30, entry.localOffset)
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`zip: entry ${name} has a bad local header`)
    const nameLength = local.readUInt16LE(26)
    const extraLength = local.readUInt16LE(28)
    const dataStart = entry.localOffset + 30 + nameLength + extraLength
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > this.size) throw new Error(`zip: entry ${name} points past the end of the file`)
    const stored = readExact(this.fd, entry.compressedSize, dataStart)
    let data
    if (entry.method === METHOD_STORE) {
      if (entry.compressedSize !== entry.uncompressedSize) throw new Error(`zip: stored entry ${name} has inconsistent sizes`)
      data = stored
    } else {
      try {
        data = inflateRawSync(stored, { maxOutputLength: Math.max(entry.uncompressedSize, 1) })
      } catch (error) {
        throw new Error(`zip: entry ${name} could not be inflated: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (data.length !== entry.uncompressedSize) throw new Error(`zip: entry ${name} inflated to an unexpected size`)
    }
    if (crc32(data) !== entry.crc) throw new Error(`zip: entry ${name} failed its CRC check`)
    return data
  }

  /** Read one text entry as UTF-8. */
  readText(name) {
    return this.read(name).toString('utf8')
  }

  /** Release the file descriptor; idempotent. */
  close() {
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
    } catch {
      /* already closed */
    }
    this.fd = undefined
  }
}
