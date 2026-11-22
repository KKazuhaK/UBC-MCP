export type Connection={origin:string;uploadToken:string};
export function hubOrigin(raw:string):string {
  let u:URL;try{u=new URL(raw.trim());}catch{throw new Error('Enter your MCPHub HTTPS address.');}
  // A pasted MCP endpoint (https://hub/mcp/<server>) is accepted: only its origin is kept.
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Use an HTTPS address, without a password, query or fragment.');
  return u.origin;
}
export function storedConnection(data:Record<string,any>):Connection|null {
  if(data.ubcConnection&&typeof data.ubcConnection.origin==='string'&&/^[\w-]{43}$/.test(data.ubcConnection.uploadToken??''))return {origin:hubOrigin(data.ubcConnection.origin),uploadToken:data.ubcConnection.uploadToken};
  return null;
}
