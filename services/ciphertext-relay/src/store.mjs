import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { clone, encode, decode, digest, address, integer, invariant, packetRecord, publicBundle, chunkRecord, hash, exact, identifier } from './records.mjs';
const APPLICATION_ID = 0x44414552;
function privateFile(path) {
  if (path === ':memory:') return;
  invariant(typeof path === 'string' && path.length <= 4096 && path === resolve(path), 'RELAY_DATABASE_PATH');
  const parent = dirname(path), stat = lstatSync(parent);
  invariant(typeof process.getuid === 'function' && stat.isDirectory() && !stat.isSymbolicLink() &&
    stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700 && realpathSync(parent) === parent, 'RELAY_PRIVATE_DIRECTORY');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const file = fstatSync(fd);
    invariant(file.isFile() && file.uid === process.getuid() && file.nlink === 1 && (file.mode & 0o777) === 0o600, 'RELAY_PRIVATE_FILE');
  } finally { closeSync(fd); }
}
/** Stores public prekey bundles, ciphertext and bounded routing/retention metadata.
 * Never holds endpoint identity secrets, ratchet state, media keys or decoded PCM.
 */
export class SqliteCiphertextMailbox {
  #db; #closed = false; #lastNow = 0;
  constructor(path, { maxPackets = 1024, maxMailboxPackets = 64, maxBytes = 8 * 1024 * 1024, maxChunks = 1024, maxChunkBytes = 64 * 1024 * 1024 } = {}) {
    privateFile(path); integer(maxPackets, 1, 4096); integer(maxMailboxPackets, 1, 256); integer(maxBytes, 1, 32 * 1024 * 1024);
    integer(maxChunks, 1, 4096); integer(maxChunkBytes, 16, 256 * 1024 * 1024);
    this.limits = Object.freeze({ maxPackets, maxMailboxPackets, maxBytes, maxChunks, maxChunkBytes });
    this.#db = new DatabaseSync(path, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
    try {
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF;');
      const id = this.#db.prepare('PRAGMA application_id').get().application_id;
      if (id === 0) invariant(this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n === 0, 'RELAY_UNRELATED_DATABASE');
      else invariant(id === APPLICATION_ID, 'RELAY_UNRELATED_DATABASE');
      this.#db.exec(`PRAGMA application_id=${APPLICATION_ID};
        CREATE TABLE IF NOT EXISTS relay_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, last_now INTEGER NOT NULL) STRICT;
        INSERT OR IGNORE INTO relay_meta VALUES(1,1,0);
        CREATE TABLE IF NOT EXISTS relay_packets (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT UNIQUE NOT NULL, sender TEXT NOT NULL,
          recipient TEXT NOT NULL, delivery_id TEXT NOT NULL, digest TEXT NOT NULL, body BLOB,
          expires INTEGER NOT NULL, acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)),
          UNIQUE(sender,recipient,delivery_id)) STRICT;
        CREATE INDEX IF NOT EXISTS relay_delivery ON relay_packets(recipient,acknowledged,sequence);
        CREATE TABLE IF NOT EXISTS relay_bundles (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
          body BLOB, expires INTEGER NOT NULL, taken INTEGER NOT NULL CHECK(taken IN (0,1))) STRICT;
        CREATE INDEX IF NOT EXISTS relay_public_keys ON relay_bundles(owner,taken,sequence);
        CREATE TABLE IF NOT EXISTS relay_chunks (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, application TEXT NOT NULL, tenant TEXT NOT NULL,
          object_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, readers TEXT NOT NULL,
          body BLOB NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS relay_chunk_expiry ON relay_chunks(expires);`);
      invariant(this.#db.prepare('SELECT version FROM relay_meta WHERE id=1').get().version === 1, 'RELAY_SCHEMA_UNSUPPORTED');
    } catch (error) { this.#db.close(); throw error; }
  }
  #transaction(now, operation) {
    invariant(!this.#closed, 'RELAY_STORE_CLOSED'); integer(now, this.#lastNow);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      integer(now, this.#db.prepare('SELECT last_now FROM relay_meta WHERE id=1').get().last_now);
      this.#lastNow = now;
      this.#db.prepare('DELETE FROM relay_packets WHERE expires <= ?').run(now);
      this.#db.prepare('DELETE FROM relay_bundles WHERE expires <= ?').run(now);
      this.#db.prepare('DELETE FROM relay_chunks WHERE expires <= ?').run(now);
      this.#db.prepare('UPDATE relay_meta SET last_now=? WHERE id=1').run(now);
      const value = operation(); this.#db.exec('COMMIT'); return value;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  enqueue(sender, recipient, packet, now) {
    const copy = clone(packet); packetRecord(copy, sender, recipient, now);
    const bytes = encode(copy), checksum = digest(copy);
    const receiptId = digest({ domain: 'DAE-RELAY-RECEIPT-v1', sender, recipient, deliveryId: copy.deliveryId });
    return this.#transaction(now, () => {
      const previous = this.#db.prepare('SELECT digest,acknowledged FROM relay_packets WHERE receipt=?').get(receiptId);
      if (previous) {
        invariant(previous.digest === checksum, 'RELAY_DELIVERY_ID_CONFLICT');
        return { receiptId, status: previous.acknowledged ? 'acknowledged' : 'stored' };
      }
      const count = this.#db.prepare('SELECT count(*) AS n,coalesce(sum(length(body)),0) AS bytes FROM relay_packets').get();
      const mailbox = this.#db.prepare('SELECT count(*) AS n FROM relay_packets WHERE recipient=? AND acknowledged=0').get(recipient).n;
      invariant(count.n < this.limits.maxPackets && mailbox < this.limits.maxMailboxPackets && count.bytes + bytes.length <= this.limits.maxBytes, 'RELAY_QUOTA');
      this.#db.prepare('INSERT INTO relay_packets(receipt,sender,recipient,delivery_id,digest,body,expires,acknowledged) VALUES(?,?,?,?,?,?,?,0)')
        .run(receiptId, sender, recipient, copy.deliveryId, checksum, bytes, copy.expiresAtMs);
      return { receiptId, status: 'stored' };
    });
  }
  poll(recipient, now) {
    address(recipient);
    return this.#transaction(now, () => this.#db.prepare('SELECT receipt,sender,body FROM relay_packets WHERE recipient=? AND acknowledged=0 ORDER BY sequence LIMIT 8').all(recipient)
      .map(row => ({ receiptId: row.receipt, sender: row.sender, packet: decode(row.body) })));
  }
  acknowledge(recipient, receipts, now) {
    address(recipient); invariant(Array.isArray(receipts) && receipts.length <= 8, 'RELAY_ACK_LIMIT'); receipts.forEach(address);
    return this.#transaction(now, () => {
      for (const receipt of receipts) this.#db.prepare('UPDATE relay_packets SET acknowledged=1,body=NULL WHERE recipient=? AND receipt=?').run(recipient, receipt);
    });
  }
  publish(owner, bundle, now) {
    address(owner); const copy = clone(bundle); publicBundle(copy, owner, now); const bundleId = digest(copy);
    return this.#transaction(now, () => {
      const previous = this.#db.prepare('SELECT taken FROM relay_bundles WHERE id=?').get(bundleId);
      if (previous) return { bundleId, status: previous.taken ? 'taken' : 'available' };
      invariant(this.#db.prepare('SELECT count(*) AS n FROM relay_bundles').get().n < 256 &&
        this.#db.prepare('SELECT count(*) AS n FROM relay_bundles WHERE owner=? AND taken=0').get(owner).n < 64, 'RELAY_BUNDLE_QUOTA');
      this.#db.prepare('INSERT INTO relay_bundles(id,owner,body,expires,taken) VALUES(?,?,?,?,0)').run(bundleId, owner, encode(copy), copy.body.expiresAtMs);
      return { bundleId, status: 'available' };
    });
  }
  take(owner, now) {
    address(owner);
    return this.#transaction(now, () => {
      const row = this.#db.prepare('SELECT id,body FROM relay_bundles WHERE owner=? AND taken=0 ORDER BY sequence LIMIT 1').get(owner);
      if (!row) return null;
      this.#db.prepare('UPDATE relay_bundles SET taken=1,body=NULL WHERE id=?').run(row.id);
      return decode(row.body);
    });
  }
  putChunk(owner, input, now) {
    address(owner); const value = clone(input), bytes = chunkRecord(value, now); value.readers.sort();
    const id = digest({ owner, application: value.application, tenantId: value.tenantId,
      storageObjectId: value.storageObjectId, chunkIndex: value.chunkIndex });
    const checksum = hash(bytes);
    return this.#transaction(now, () => {
      const previous = this.#db.prepare('SELECT digest,readers,expires FROM relay_chunks WHERE id=?').get(id);
      if (previous) {
        invariant(previous.digest === checksum && previous.readers === encode(value.readers).toString() &&
          previous.expires === value.expiresAtMs, 'RELAY_CHUNK_CONFLICT');
        return { chunkId: id, status: 'stored' };
      }
      const total = this.#db.prepare('SELECT count(*) AS n,coalesce(sum(length(body)),0) AS bytes FROM relay_chunks').get();
      invariant(total.n < this.limits.maxChunks && total.bytes + bytes.length <= this.limits.maxChunkBytes, 'RELAY_CHUNK_QUOTA');
      this.#db.prepare('INSERT INTO relay_chunks VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, owner, value.application, value.tenantId,
        value.storageObjectId, value.chunkIndex, encode(value.readers).toString(), bytes, checksum, value.expiresAtMs);
      return { chunkId: id, status: 'stored' };
    });
  }
  readChunk(recipient, owner, request, now) {
    address(recipient); address(owner);
    exact(request, ['application','tenantId','storageObjectId','chunkIndex','expectedBytes']);
    // Existing endpoint request validation applies before database lookup.
    invariant(['scenesignal','distributed-radio'].includes(request.application), 'RELAY_INVALID_APPLICATION');
    identifier(request.tenantId); identifier(request.storageObjectId); integer(request.chunkIndex, 0, 16383);
    integer(request.expectedBytes, 16, 256 * 1024 + 16);
    const { expectedBytes, ...fields } = request; const id = digest({ owner, ...fields });
    return this.#transaction(now, () => {
      const row = this.#db.prepare('SELECT body,readers,digest FROM relay_chunks WHERE id=?').get(id);
      invariant(row && decode(Buffer.from(row.readers)).includes(recipient), 'RELAY_CHUNK_UNAVAILABLE');
      invariant(row.body.length === expectedBytes && hash(row.body) === row.digest, 'RELAY_CHUNK_CORRUPT_OR_LENGTH');
      return Uint8Array.from(row.body);
    });
  }
  sweep(now) { return this.#transaction(now, () => undefined); }
  stats(now) {
    return this.#transaction(now, () => {
      const p = this.#db.prepare('SELECT count(*) AS retained,sum(1-acknowledged) AS pending,coalesce(sum(length(body)),0) AS bytes FROM relay_packets').get();
      const b = this.#db.prepare('SELECT count(*) AS retained,sum(1-taken) AS available FROM relay_bundles').get();
      const c = this.#db.prepare('SELECT count(*) AS n,coalesce(sum(length(body)),0) AS bytes FROM relay_chunks').get();
      return { packets: p.retained, pending: p.pending ?? 0, bytes: p.bytes, bundles: b.retained, availableBundles: b.available ?? 0, chunks: c.n, chunkBytes: c.bytes };
    });
  }
  close() { if (this.#closed) return; this.#closed = true; this.#db.close(); }
}
