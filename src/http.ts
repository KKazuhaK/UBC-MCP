export class SourceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export async function readBounded(response: Response, maxBytes = 8_000_000): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new SourceError('RESPONSE_TOO_LARGE', 'Response exceeded size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) throw new SourceError('RESPONSE_TOO_LARGE','Response exceeded size limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export class PublicHttp {
  private cache = new Map<string, {text:string; fetchedAt:string; expires:number}>();
  private pending = new Map<string, Promise<{text:string; fetchedAt:string}>>();
  constructor(private request: typeof fetch = fetch) {}
  async get(url: string, ttl = 21_600_000): Promise<{text:string; fetchedAt:string}> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password ||
      !['ubcgrades.com','vancouver.calendar.ubc.ca','okanagan.calendar.ubc.ca'].includes(u.host))
      throw new SourceError('INVALID_SOURCE','Unapproved public data source');
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) return cached;
    const pending = this.pending.get(url); if (pending) return pending;
    const job = (async () => {
      const r = await this.request(url, {headers:{'User-Agent':'ubc-mcp/0.1.0-alpha.3',Accept:'application/json,text/html'},
        redirect:'error',signal:AbortSignal.timeout(25_000)});
      if (!r.ok) {
        await r.body?.cancel();
        throw new SourceError(`UPSTREAM_${r.status}`, r.status === 429 ?
          'Source rate limit reached; try later.' : `Public source returned HTTP ${r.status}`);
      }
      const value = {text:await readBounded(r), fetchedAt:new Date().toISOString(), expires:Date.now()+ttl};
      if (this.cache.size >= 250) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(url,value); return value;
    })();
    this.pending.set(url,job);
    try { return await job; } finally { this.pending.delete(url); }
  }
  status() { return {cachedRequests:this.cache.size, inFlight:this.pending.size}; }
}
