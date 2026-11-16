'use strict';

const { responseError } = require('./service');

const HEALTH_TIMEOUT_MS = 5000;
const DATA_TIMEOUT_MS = 12000;

/** Fetch JSON from the configured loopback service with bounded requests. */
class BackendClient {
  constructor(backendUrl, fetchImpl = globalThis.fetch) {
    this.backendUrl = backendUrl;
    this.fetch = fetchImpl;
  }

  /** Resolve an API path against the current extension setting. */
  url(path) {
    const base = new URL(this.backendUrl());
    return new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base : `${base.href}/`);
  }

  async get(path, timeoutMilliseconds = DATA_TIMEOUT_MS) {
    return this.request(path, { headers: { Accept: 'application/json' } }, timeoutMilliseconds);
  }

  /** Conditional GET keeps unchanged snapshots from being transferred again. */
  async poll(path, etag, timeoutMilliseconds = DATA_TIMEOUT_MS) {
    const headers = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    return this.request(path, { headers }, timeoutMilliseconds, true);
  }

  /** POST a JSON body for the service's explicitly enabled write routes. */
  async post(path, body = {}, timeoutMilliseconds = 30000) {
    return this.request(path, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMilliseconds);
  }

  async request(path, init, timeoutMilliseconds, conditional = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await this.fetch(this.url(path), { ...init, signal: controller.signal });
      if (conditional && response.status === 304) return { notModified: true };
      let payload;
      try { payload = await response.json(); }
      catch (_error) { throw responseError(response.status, null); }
      if (!response.ok) throw responseError(response.status, payload);
      return conditional ? { payload, etag: response.headers.get('etag') || undefined } : payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Cluster Watcher service request timed out (${path})`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Probe older backends that lack the small service identity endpoint. */
  async legacyServiceProbe() {
    try {
      const payload = await this.get('/api/v1/snapshot?detail=summary', HEALTH_TIMEOUT_MS);
      if (payload?.schema_version) return true;
    } catch (_error) { /* An initial collection may still be returning 503. */ }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await this.fetch(this.url('/api/status'), {
        signal: controller.signal, headers: { Accept: 'application/json' },
      });
      const payload = await response.json();
      return Boolean(payload && ('updated_at' in payload || 'refresh_seconds' in payload));
    } catch (_error) {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Identify a running backend without serializing the full cluster snapshot. */
  async isClusterWatcherService() {
    try {
      const payload = await this.get('/api/v1/service', HEALTH_TIMEOUT_MS);
      return Boolean(payload?.schema_version);
    } catch (error) {
      return error?.status === 404 ? this.legacyServiceProbe() : false;
    }
  }

  /** Return process identity; only older backends need the legacy probe. */
  async serviceInfo() {
    try {
      return await this.get('/api/v1/service', HEALTH_TIMEOUT_MS);
    } catch (error) {
      if (error?.status === 404 && await this.legacyServiceProbe()) return {};
      throw error;
    }
  }

  /** Read the server's cached, loopback-only SSH control-master inventory. */
  async sessionInfo() {
    return this.get('/api/v1/sessions');
  }
}

module.exports = { BackendClient, HEALTH_TIMEOUT_MS };
