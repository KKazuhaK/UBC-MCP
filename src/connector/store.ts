import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {parseSnapshot} from '../model.js';
import type {Snapshot} from '../model.js';

export const normalizeIssuer=(s:string)=>s.endsWith('/')?s.slice(0,-1):s;
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
      CREATE TABLE IF NOT EXISTS accounts(username TEXT NOT NULL,issuer_key TEXT NOT NULL DEFAULT '',issuer TEXT,binding_id TEXT NOT NULL REFERENCES bindings(id),credentials TEXT NOT NULL,PRIMARY KEY(username,issuer_key));
      CREATE TABLE IF NOT EXISTS pairing(code_hash TEXT PRIMARY KEY,binding_id TEXT NOT NULL REFERENCES bindings(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(binding_id TEXT NOT NULL REFERENCES bindings(id),scope TEXT NOT NULL,captured_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(binding_id,scope));`);
    // Databases from before issuer-bound accounts keyed accounts by username alone.
    if(!this.db.prepare('PRAGMA table_info(accounts)').all().some(c=>c.name==='issuer_key')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`CREATE TABLE accounts_new(username TEXT NOT NULL,issuer_key TEXT NOT NULL DEFAULT '',issuer TEXT,binding_id TEXT NOT NULL REFERENCES bindings(id),credentials TEXT NOT NULL,PRIMARY KEY(username,issuer_key));
          INSERT INTO accounts_new(username,issuer_key,issuer,binding_id,credentials) SELECT username,'',NULL,binding_id,credentials FROM accounts;
          DROP TABLE accounts; ALTER TABLE accounts_new RENAME TO accounts;`);
        this.db.exec('COMMIT');
      }catch(e){this.db.exec('ROLLBACK');throw e;}
    }
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
      this.db.prepare('DELETE FROM pairing WHERE binding_id=?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE binding_id=?').run(id);
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
  private seal(text:string,aad:string) {
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(aad));
    const body=Buffer.concat([c.update(text,'utf8'),c.final()]);
    return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');
  }
  private unseal(body:string,aad:string) {
    const b=Buffer.from(body,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));
    d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(12,28));
    return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');
  }
  /**
   * Platform accounts (created by the platform adapters) live in the issuer-less
   * namespace keyed by username. A platform account may carry the issuer
   * recorded when it was created or reconnected through OAuth (null: legacy).
   */
  account(username:string,create=false):{id:string;readToken:string;uploadToken:string}|null {
    return this.accountIn(username,'',create,null);
  }
  /** An account created for one issuer+sub pair (standalone use; see link-account). */
  linkedAccount(issuer:string,sub:string,create=false):{id:string;readToken:string;uploadToken:string}|null {
    const key=normalizeIssuer(issuer);return this.accountIn(sub,key,create,key);
  }
  private accountIn(username:string,key:string,create:boolean,issuer:string|null) {
    const row=this.db.prepare('SELECT a.binding_id,a.credentials FROM accounts a JOIN bindings b ON b.id=a.binding_id WHERE a.username=? AND a.issuer_key=? AND b.revoked=0').get(username,key);
    if(row)return JSON.parse(this.unseal(String(row.credentials),`account:${username}:${row.binding_id}`));
    if(!create)return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const binding=this.create(key?'Linked UBC connection':'Self-service UBC connection');
      this.db.prepare('INSERT INTO accounts(username,issuer_key,issuer,binding_id,credentials) VALUES(?,?,?,?,?) ON CONFLICT(username,issuer_key) DO UPDATE SET issuer=excluded.issuer,binding_id=excluded.binding_id,credentials=excluded.credentials')
        .run(username,key,issuer,binding.id,this.seal(JSON.stringify(binding),`account:${username}:${binding.id}`));
      this.db.exec('COMMIT');return binding;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  /** Records which issuer a platform account was created or reconnected through. */
  recordIssuer(username:string,issuer:string) {
    this.db.prepare("UPDATE accounts SET issuer=? WHERE username=? AND issuer_key=''").run(normalizeIssuer(issuer),username);
  }
  /**
   * Account for a token's verified issuer and subject. `issuer`: tied to this
   * issuer (linked, or a platform account that recorded it). `legacy`: a
   * platform account with no recorded issuer; the caller must decide whether
   * the issuer is the platform's own authority before using it.
   */
  accountForIssuer(iss:string,sub:string):{account:{id:string;readToken:string;uploadToken:string};via:'issuer'|'legacy'}|null {
    const issuer=normalizeIssuer(iss),linked=this.accountIn(sub,issuer,false,issuer);
    if(linked)return {account:linked,via:'issuer'};
    const row=this.db.prepare("SELECT issuer FROM accounts WHERE username=? AND issuer_key=''").get(sub);
    if(!row)return null;
    const recorded=row.issuer===null||row.issuer===undefined?null:String(row.issuer);
    if(recorded!==null&&recorded!==issuer)return null;
    const account=this.accountIn(sub,'',false,null);
    return account?{account,via:recorded===null?'legacy':'issuer'}:null;
  }
  pair(username:string) {
    const a=this.account(username);if(!a)throw new Error('Not connected');
    const code=randomBytes(32).toString('base64url'),expires=Date.now()+5*60_000;
    this.db.prepare('DELETE FROM pairing WHERE binding_id=? OR expires<?').run(a.id,Date.now());
    this.db.prepare('INSERT INTO pairing VALUES(?,?,?)').run(digest(code),a.id,expires);
    return {code,expires};
  }
  claim(code:string) {
    if(!/^[\w-]{43}$/.test(code))return null;
    const row=this.db.prepare('SELECT p.binding_id,a.username FROM pairing p JOIN accounts a ON a.binding_id=p.binding_id JOIN bindings b ON b.id=p.binding_id WHERE p.code_hash=? AND p.expires>? AND b.revoked=0').get(digest(code),Date.now());
    if(!row)return null;
    this.db.prepare('DELETE FROM pairing WHERE code_hash=?').run(digest(code));
    return {uploadToken:this.account(String(row.username))!.uploadToken};
  }
  close(){this.db.close();}
}
