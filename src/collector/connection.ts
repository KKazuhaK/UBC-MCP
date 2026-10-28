// No server address is built into the source. Only legacy (0.2.x) connections,
// which stored a token without an origin, need one; a release build may supply
// it at build time via UBC_LEGACY_HUB_ORIGIN (esbuild define). Unset means such
// connections are treated as not connected and the user pairs again.
declare global{var __UBC_LEGACY_HUB__:string|undefined;}
export function legacyHub():string {
  const raw=globalThis.__UBC_LEGACY_HUB__;
  if(!raw)return '';
  try{return hubOrigin(raw);}catch{return '';}
}
export type Connection={origin:string;uploadToken:string};
export function hubOrigin(raw:string):string {
  let u:URL;try{u=new URL(raw.trim());}catch{throw new Error('Enter your MCPHub HTTPS address.');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('Use an HTTPS origin, without a path, password, query or fragment.');
  return u.origin;
}
export function storedConnection(data:Record<string,any>):Connection|null {
  if(data.ubcConnection&&typeof data.ubcConnection.origin==='string'&&/^[\w-]{43}$/.test(data.ubcConnection.uploadToken??''))return {origin:hubOrigin(data.ubcConnection.origin),uploadToken:data.ubcConnection.uploadToken};
  // Older releases paired only with one deployment, supplied at build time if at all.
  const legacy=legacyHub();
  const token=data.ubcUploadToken??data.ubcLegacyToken??'';
  return legacy&&/^[\w-]{43}$/.test(token)?{origin:legacy,uploadToken:token}:null;
}
