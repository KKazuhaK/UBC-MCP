import {readFile} from 'node:fs/promises';
import {parseSnapshot} from '../model.js';
import {readBounded, SourceError} from '../http.js';
import type {Snapshot} from '../model.js';

export class Personal {
  constructor(private config: {file?:string|undefined;url?:string|undefined;token?:string|undefined}) {}
  configured() {return !!(this.config.file || (this.config.url && this.config.token));}
  async snapshots():Promise<Snapshot[]> {
    if (this.config.file) {
      const data=JSON.parse(await readFile(this.config.file,'utf8'));
      return (Array.isArray(data)?data:[data]).map(s=>parseSnapshot(s));
    }
    if (!this.config.url || !this.config.token)
      throw new SourceError('PERSONAL_NOT_CONNECTED','Bind your own UBC connector token in Hub Credentials.');
    const base=new URL(this.config.url);
    if ((base.protocol!=='https:' && !(base.protocol==='http:'&&['127.0.0.1','localhost','ubc-connector'].includes(base.hostname))) ||
      base.username || base.password || base.search || base.hash)
      throw new SourceError('INVALID_CONNECTOR','Connector requires HTTPS or an approved internal address');
    const r=await fetch(new URL('/v1/snapshots',base),{headers:{Authorization:`Bearer ${this.config.token}`},
      redirect:'error',signal:AbortSignal.timeout(15_000)});
    if (!r.ok) {
      await r.body?.cancel();
      throw new SourceError(r.status===401?'CONNECTION_REVOKED':'CONNECTOR_UNAVAILABLE',
        r.status===401?'Personal connection is missing or revoked. Rebind your own connection.':`Connector HTTP ${r.status}`);
    }
    const data:unknown=JSON.parse(await readBounded(r,12_000_000));
    if (!Array.isArray(data) || data.length>20) throw new SourceError('INVALID_SNAPSHOT','Invalid connector snapshot list');
    return data.map(s=>parseSnapshot(s));
  }
}
