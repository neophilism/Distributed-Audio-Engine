import { snapshot, exact, integer, invariant } from './validation.mjs';
const address = value => invariant(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'PARENT_RELAY_ADDRESS');

/** Explicit bounded endpoint operations, not a service, timer or playback loop.
 * The transport must honor AbortSignal (CiphertextRelayClient does). A successful
 * pull acknowledges only AFTER authentication and the encrypted journal commit.
 * Neither transport receipt nor durable intake is application execution.
 */
export class SignalRelayEndpoint {
  #channel; #relay; #clock; #timeout; #lastNow = 0; #busy; #closed = false;
  constructor({ channel, relay, nowUnixMs, timeoutMs = 10_000 }) {
    invariant(channel && typeof channel.receivePacket === 'function' && typeof nowUnixMs === 'function', 'PARENT_RELAY_OPTIONS');
    for (const name of ['send', 'poll', 'acknowledge']) invariant(typeof relay?.[name] === 'function', 'PARENT_RELAY_TRANSPORT');
    integer(timeoutMs, 50, 30_000);
    this.#channel = channel; this.#relay = relay; this.#clock = nowUnixMs; this.#timeout = timeoutMs;
  }
  #check(signal, expiresAtMs) {
    invariant(!this.#closed, 'PARENT_RELAY_CLOSED'); invariant(!signal.aborted, 'PARENT_RELAY_ABORTED');
    const now = this.#clock();
    try { integer(now, this.#lastNow); } catch { this.close(); throw Error('PARENT_RELAY_CLOCK_ROLLBACK'); }
    this.#lastNow = now;
    if (expiresAtMs !== undefined) invariant(expiresAtMs > now, 'PARENT_RELAY_EXPIRED');
  }
  async #run(signal, work) {
    invariant(!this.#closed && !this.#busy, 'PARENT_RELAY_CLOSED_OR_BUSY');
    invariant(signal === undefined || signal instanceof AbortSignal, 'PARENT_RELAY_SIGNAL');
    const controller = new AbortController(), abort = () => controller.abort();
    this.#busy = controller; signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout); timer.unref();
    try { this.#check(controller.signal); return await work(controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#busy = undefined; }
  }
  async flush(recipient, signal) {
    address(recipient);
    return this.#run(signal, async active => {
      const deliveries = (await this.#channel.pendingDeliveries(recipient)).slice(0, 8);
      let sent = 0;
      for (const entry of deliveries) {
        this.#check(active, entry.packet.expiresAtMs);
        this.#channel.requirePeer(recipient, entry.kind, 'send');
        const response = snapshot(await this.#relay.send(recipient, snapshot(entry.packet), active));
        this.#check(active, entry.packet.expiresAtMs);
        exact(response, ['receiptId', 'status']); address(response.receiptId);
        invariant(['stored', 'acknowledged'].includes(response.status), 'PARENT_RELAY_RECEIPT');
        this.#channel.requirePeer(recipient, entry.kind, 'send');
        await this.#channel.markDeliverySent(entry.packet.deliveryId);
        this.#check(active); sent++;
      }
      this.#check(active); return { sent };
    });
  }
  async pull(signal) {
    return this.#run(signal, async active => {
      const rows = snapshot(await this.#relay.poll(active)); this.#check(active);
      invariant(Array.isArray(rows) && rows.length <= 8, 'PARENT_RELAY_BATCH_LIMIT');
      const received = [], receipts = new Set();
      for (const row of rows) {
        exact(row, ['receiptId', 'sender', 'packet']); address(row.receiptId); address(row.sender);
        invariant(!receipts.has(row.receiptId), 'PARENT_RELAY_DUPLICATE_RECEIPT'); receipts.add(row.receiptId);
        this.#check(active, row.packet.expiresAtMs);
        const message = await this.#channel.receivePacket(row.packet, row.sender);
        this.#check(active, message.expiresAtMs);
        this.#channel.requirePeer(message.sender, message.kind, 'receive');
        // A lost acknowledgment response is harmless: repeat intake returns the
        // same durable entry or completed tombstone without re-decryption.
        await this.#relay.acknowledge([row.receiptId], active);
        this.#check(active, message.expiresAtMs); received.push(message);
      }
      for (const message of received) {
        this.#channel.requirePeer(message.sender, message.kind, 'receive'); this.#check(active, message.expiresAtMs);
      }
      return received;
    });
  }
  /** Cancels this wrapper only. The caller owns the channel and transport. */
  close() { this.#closed = true; this.#busy?.abort(); }
}
