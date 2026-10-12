import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync,
  fsyncSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson, parseCanonicalJson, jsonBytes, exact, identifier, integer, invariant, snapshot } from './validation.mjs';

const LIMIT = 1_048_576;
const MAGIC = Buffer.from('DAEVLT01');

/** POSIX encrypted endpoint storage. Not a hardware-backed anti-rollback service.
 * AES-GCM authenticates the entire bounded snapshot and endpoint binding. CAS,
 * a create-exclusive lock, fsync and atomic rename precede plaintext release.
 * The application supplies its own 32-byte device key; no relay key is accepted.
 */
export class EncryptedFileVault {
  #key; #binding; #directory; #filename; #highWater; #closed = false;
  constructor({ directory, filename = 'signal.vault', key, binding, minimumRevision = 0 }) {
    invariant(process.platform !== 'win32' && typeof process.getuid === 'function', 'VAULT_POSIX_REQUIRED');
    identifier(filename); integer(minimumRevision);
    invariant(key instanceof Uint8Array && !(key.buffer instanceof SharedArrayBuffer) && key.byteLength === 32, 'VAULT_INVALID_KEY');
    this.#directory = directory; this.#filename = filename; this.#highWater = minimumRevision;
    this.#binding = jsonBytes({ domain: 'DAE-ENDPOINT-VAULT-v1', binding });
    invariant(this.#binding.length <= 2048, 'VAULT_BINDING_LIMIT');
    this.#key = Buffer.from(key);
    try { this.#checkDirectory(); this.#load(); } catch (error) { this.close(); throw error; }
  }
  #checkDirectory() {
    const stat = lstatSync(this.#directory);
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o700 && realpathSync(this.#directory) === this.#directory, 'VAULT_PRIVATE_DIRECTORY_REQUIRED');
  }
  #path() { return join(this.#directory, this.#filename); }
  #file(fd) {
    const stat = fstatSync(fd);
    invariant(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 &&
      stat.nlink === 1 && stat.size <= LIMIT + 36, 'VAULT_UNSAFE_FILE');
    return stat;
  }
  #load() {
    invariant(!this.#closed, 'VAULT_CLOSED'); this.#checkDirectory();
    let fd;
    try { fd = openSync(this.#path(), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      invariant(this.#highWater === 0, 'VAULT_ROLLBACK_OR_DELETION');
      return { revision: 0, entries: Object.create(null) };
    }
    let raw, plaintext, tentative;
    try {
      const stat = this.#file(fd); raw = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < raw.length) {
        const count = readSync(fd, raw, length, raw.length - length, null);
        if (!count) break;
        length += count;
      }
      invariant(length === stat.size, 'VAULT_FILE_CHANGED'); raw = raw.subarray(0, length);
      invariant(raw.length >= 36 && raw.length <= LIMIT + 36 && raw.subarray(0, 8).equals(MAGIC), 'VAULT_INVALID_FILE');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(8, 20), { authTagLength: 16 });
      decipher.setAAD(this.#binding); decipher.setAuthTag(raw.subarray(20, 36));
      try { tentative = decipher.update(raw.subarray(36)); plaintext = Buffer.concat([tentative, decipher.final()]); }
      catch { throw new Error('VAULT_AUTHENTICATION_FAILED'); }
      const data = parseCanonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
      exact(data, ['revision', 'entries']); integer(data.revision, 1);
      invariant(data.revision >= this.#highWater, 'VAULT_ROLLBACK_OR_DELETION');
      invariant(data.entries && !Array.isArray(data.entries) && typeof data.entries === 'object' &&
        Object.keys(data.entries).length <= 64, 'VAULT_ENTRY_LIMIT');
      for (const [name, entry] of Object.entries(data.entries)) {
        identifier(name); exact(entry, ['revision', 'value']); integer(entry.revision, 1, data.revision);
      }
      this.#highWater = data.revision;
      return data;
    } finally { tentative?.fill(0); plaintext?.fill(0); raw?.fill(0); closeSync(fd); }
  }
  read(name) { identifier(name); const value = this.#load().entries[name]; return value ? snapshot(value) : undefined; }
  get revision() { return this.#load().revision; }
  compareAndSet(name, expectedRevision, value) {
    identifier(name); if (expectedRevision !== undefined) integer(expectedRevision, 1);
    // Snapshot before taking a filesystem lock; never invoke caller accessors.
    const next = snapshot(value); this.#checkDirectory();
    invariant(!this.#closed, 'VAULT_CLOSED');
    const lockPath = this.#path() + '.lock'; let lock;
    try { lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('VAULT_BUSY_OR_RECOVERY_REQUIRED'); throw error; }
    let temporary, output, plaintext, fd, renamed = false;
    try {
      this.#file(lock);
      const document = this.#load();
      if (document.entries[name]?.revision !== expectedRevision) return false;
      invariant(document.revision < Number.MAX_SAFE_INTEGER, 'VAULT_REVISION_EXHAUSTED');
      const revision = document.revision + 1;
      document.revision = revision; document.entries[name] = { revision, value: next };
      invariant(Object.keys(document.entries).length <= 64, 'VAULT_ENTRY_LIMIT');
      plaintext = jsonBytes(document); invariant(plaintext.length <= LIMIT, 'VAULT_SIZE_LIMIT');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce, { authTagLength: 16 });
      cipher.setAAD(this.#binding);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      output = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]); ciphertext.fill(0);
      temporary = this.#path() + '.' + randomUUID() + '.tmp';
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, output); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.#path()); renamed = true;
      this.#highWater = revision;
      const dir = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return true;
    } finally {
      if (fd !== undefined) closeSync(fd);
      plaintext?.fill(0); output?.fill(0);
      if (temporary && !renamed) { try { unlinkSync(temporary); } catch {} }
      closeSync(lock); unlinkSync(lockPath);
    }
  }
  close() { this.#closed = true; this.#key?.fill(0); }
}

/** Independent encrypted row for the portable verifier's synchronous replay CAS. */
export class EncryptedCheckpointStore {
  constructor(vault) { this.vault = vault; }
  read(scopeKey) {
    const row = this.vault.read('control-checkpoints');
    const found = row?.value.find(item => item.scope === scopeKey);
    return found ? { epoch: found.epoch, sequence: found.sequence } : undefined;
  }
  compareAndSet(scopeKey, expected, next) {
    invariant(typeof scopeKey === 'string' && scopeKey.length <= 1024, 'CHECKPOINT_INVALID_SCOPE');
    integer(next.epoch, 1); integer(next.sequence, 1);
    const row = this.vault.read('control-checkpoints'); const entries = row?.value ?? [];
    invariant(Array.isArray(entries) && entries.length <= 32, 'CHECKPOINT_LIMIT');
    const previous = entries.find(entry => entry.scope === scopeKey);
    if (canonicalJson(previous ? { epoch: previous.epoch, sequence: previous.sequence } : null) !== canonicalJson(expected ?? null)) return false;
    invariant(!previous ? next.sequence === 1 : next.epoch >= previous.epoch &&
      (next.epoch === previous.epoch ? next.sequence === previous.sequence + 1 : next.sequence === 1), 'CHECKPOINT_REPLAY_OR_GAP');
    const updated = entries.filter(entry => entry.scope !== scopeKey);
    invariant(updated.length < 32, 'CHECKPOINT_LIMIT'); updated.push({ scope: scopeKey, ...next });
    return this.vault.compareAndSet('control-checkpoints', row?.revision, updated);
  }
}
