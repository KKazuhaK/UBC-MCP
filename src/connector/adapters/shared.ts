import {isExtensionOrigin} from '../extension-origin.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../store.js';

export const SERVER_NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const PAGE_HEADERS={'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
type Send=(status:number,value:unknown)=>void;

/**
 * One-use random code exchanged by the browser extension for an upload
 * credential. It never authorizes a platform session.
 */
export async function handleClaim(store:Store,req:IncomingMessage,res:ServerResponse,send:Send) {
  if(req.headers.cookie||(req.headers.origin&&!isExtensionOrigin(req.headers.origin))){send(403,{error:'EXTENSION_REQUIRED'});return;}
  if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
  const chunks:Buffer[]=[];let n=0;
  for await(const c of req){n+=c.length;if(n>1024){send(413,{error:'TOO_LARGE'});return;}chunks.push(c);}
  try{const result=store.claim(JSON.parse(Buffer.concat(chunks).toString()).code);send(result?200:401,result??{error:'PAIRING_EXPIRED_OR_USED'});}catch{send(400,{error:'INVALID_REQUEST'});}
}
