import { id, nowIso } from './utils.mjs';

export class EventBus {
  constructor({ historyLimit = 2000 } = {}) {
    this.clients = new Map();
    this.history = [];
    this.historyLimit = historyLimit;
    this.listeners = new Set();
  }

  emit(type, payload = {}, scope = {}) {
    const event = {
      id: id('evt'),
      type,
      timestamp: nowIso(),
      ...scope,
      payload,
    };
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listeners are isolated */ }
    }
    for (const [clientId, client] of this.clients) {
      if (client.filter && !client.filter(event)) continue;
      try {
        client.response.write(`id: ${event.id}\n`);
        client.response.write(`event: ${type}\n`);
        client.response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        this.clients.delete(clientId);
      }
    }
    return event;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(request, response, filter = null) {
    const clientId = id('sse');
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: nowIso() })}\n\n`);
    this.clients.set(clientId, { response, filter });
    const heartbeat = setInterval(() => {
      try { response.write(`: heartbeat ${Date.now()}\n\n`); } catch { clearInterval(heartbeat); }
    }, 15_000);
    heartbeat.unref();
    request.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(clientId);
    });
    return clientId;
  }

  recent(limit = 200, predicate = null) {
    const values = predicate ? this.history.filter(predicate) : this.history;
    return values.slice(-limit);
  }
}
