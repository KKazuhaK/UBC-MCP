export const DEFAULT_HUB='https://mcp.kazuhahub.com';
export type Connection={origin:string;uploadToken:string};
export function hubOrigin(raw:string):string {
  let u:URL;try{u=new URL(raw.trim());}catch{throw new Error('Enter your MCPHub HTTPS address.');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('Use an HTTPS origin, without a path, password, query or fragment.');
  return u.origin;
}
export function storedConnection(data:Record<string,any>):Connection|null {
  if(data.ubcConnection&&typeof data.ubcConnection.origin==='string'&&/^[\w-]{43}$/.test(data.ubcConnection.uploadToken??''))return {origin:hubOrigin(data.ubcConnection.origin),uploadToken:data.ubcConnection.uploadToken};
  // Older releases paired only with the original deployment.
  return /^[\w-]{43}$/.test(data.ubcUploadToken??'')?{origin:DEFAULT_HUB,uploadToken:data.ubcUploadToken}:null;
}
