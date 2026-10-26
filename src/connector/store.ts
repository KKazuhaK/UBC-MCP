import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {parseSnapshot} from '../model.js';
import type {Snapshot} from '../model.js';

const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export class Store {
  private db:DatabaseSync; private key:Buffer;
  constructor(directory:string) {
    mkdirSync(directory,{recursive:true,mode:0o700}); chmodSync(directory,0o700);
    const path=join(directory,'connector.sqlite'), keyPath=join(directory,'encryption.key');
    const existing=existsSync(path);
    if (existing&&!existsSync(keyPath)) throw new Error('Existing connector database is missing its encryption key');
    if (!existsSync(keyPath)) writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
    this.key=readFileSync(keyPath); if (this.key.length!==32) throw new Error('Invalid encryption key');
    chmodSync(keyPath,0o600);
    this.db=new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,label TEXT NOT NULL,read_hash TEXT UNIQUE NOT NULL,upload_hash TEXT UNIQUE NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS snapshots(binding_id TEXT NOT NULL REFERENCES bindings(id),scope TEXT NOT NULL,captured_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(binding_id,scope));`);
  }
  create(label:string) {
    if (!label.trim()||label.length>100) throw new Error('Binding label is required (1-100 characters)');
    const id=randomBytes(16).toString('hex'),readToken=randomBytes(32).toString('base64url'),uploadToken=randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO bindings(id,label,read_hash,upload_hash) VALUES(?,?,?,?)').run(id,label,digest(readToken),digest(uploadToken));
    return {id,readToken,uploadToken};
  }
  authenticate(token:string,mode:'read'|'upload') {
    if (!/^[\w-]{43}$/.test(token)) return null;
    const column=mode==='read'?'read_hash':'upload_hash';
    const row=this.db.prepare(`SELECT id FROM bindings WHERE ${column}=? AND revoked=0`).get(digest(token));
    return row?String(row.id):null;
  }
  revoke(id:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE bindings SET revoked=1 WHERE id=?').run(id);
      this.db.prepare('DELETE FROM snapshots WHERE binding_id=?').run(id);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  private active(id:string) {if (!this.db.prepare('SELECT id FROM bindings WHERE id=? AND revoked=0').get(id)) throw new Error('Binding revoked');}
  put(id:string,input:unknown) {
    this.active(id);const s=parseSnapshot(input);
    const scope=JSON.stringify([s.campus,s.academicPeriod.id,s.kind]);
    const old=this.db.prepare('SELECT captured_at FROM snapshots WHERE binding_id=? AND scope=?').get(id,scope);
    if (old&&Date.parse(String(old.captured_at))>=Date.parse(s.capturedAt)) throw new Error('Snapshot is older than or equal to stored observation');
    const n=Number(this.db.prepare('SELECT count(*) AS n FROM snapshots WHERE binding_id=?').get(id)!.n);
    if (!old&&n>=20) throw new Error('At most twenty periods may be stored per binding');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(`${id}:${scope}`));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(s),'utf8'),cipher.final()]);
    const body=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
    this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?) ON CONFLICT(binding_id,scope) DO UPDATE SET captured_at=excluded.captured_at,body=excluded.body').run(id,scope,s.capturedAt,body);
    return {capturedAt:s.capturedAt,sections:s.sections.length};
  }
  get(id:string):Snapshot[] {
    this.active(id);
    return this.db.prepare('SELECT scope,body FROM snapshots WHERE binding_id=? ORDER BY scope').all(id).map(row=>{
      const bytes=Buffer.from(String(row.body),'base64'),decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));
      decipher.setAAD(Buffer.from(`${id}:${String(row.scope)}`));decipher.setAuthTag(bytes.subarray(12,28));
      return parseSnapshot(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')));
    });
  }
  close(){this.db.close();}
}
