export class CdpConnection {
  constructor(url, { eventLimit = 2000 } = {}) {
    this.url = url;
    this.eventLimit = eventLimit;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect(timeoutMs = 15_000) {
    if (this.socket?.readyState === WebSocket.OPEN) return this;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket connection timed out: ${this.url}`)), timeoutMs);
      timer.unref();
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP WebSocket connection failed: ${this.url}`)); }, { once: true });
    });
    socket.addEventListener('message', (event) => this.#message(event.data));
    socket.addEventListener('close', () => this.#close());
    socket.addEventListener('error', () => this.#close());
    return this;
  }

  async send(method, params = {}, timeoutMs = 30_000) {
    await this.connect();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  recent(method = null, limit = 200) {
    const events = method ? this.events.filter((event) => event.method === method) : this.events;
    return events.slice(-limit);
  }

  #message(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `CDP error ${message.error.code}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      this.events.push({ ...message, at: new Date().toISOString() });
      if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
    }
  }

  #close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
  }

  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
    this.#close();
  }
}
