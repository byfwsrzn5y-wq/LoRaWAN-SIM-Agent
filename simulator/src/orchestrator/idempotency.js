class IdempotencyStore {
  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  _now() {
    return Date.now();
  }

  _cleanup() {
    const now = this._now();
    for (const [k, v] of this.map.entries()) {
      if (v.expireAt <= now) this.map.delete(k);
    }
  }

  key(method, path, idemKey) {
    return `${method.toUpperCase()} ${path} :: ${idemKey || ''}`;
  }

  get(method, path, idemKey) {
    this._cleanup();
    if (!idemKey) return null;
    return this.map.get(this.key(method, path, idemKey)) || null;
  }

  set(method, path, idemKey, response) {
    if (!idemKey) return;
    this._cleanup();
    this.map.set(this.key(method, path, idemKey), {
      ...response,
      expireAt: this._now() + this.ttlMs,
    });
  }
}

module.exports = { IdempotencyStore };
