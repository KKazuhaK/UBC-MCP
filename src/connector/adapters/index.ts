import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../store.js';
import {mcphubAdapter} from './mcphub.js';
import {mcphubOAuthAdapter} from './mcphub-oauth.js';
import {mcpConfigFromEnv} from '../mcp-http.js';

/**
 * A platform adapter lets a hosting platform (for example an MCP aggregator)
 * provision per-user connections. The connector core never imports platform
 * code; it only sees this interface. With no adapter configured the connector
 * serves the bearer-token snapshot API and the CLI (create-binding, revoke,
 * push) only.
 */
export type PlatformAdapter={
  name:string;
  /** Exact request paths for which a browser-extension CORS preflight is answered. */
  preflightPaths:string[];
  handles(url:string):boolean;
  handle(req:IncomingMessage,res:ServerResponse,send:(status:number,value:unknown)=>void):Promise<void>;
};

export type AdapterEnv=Record<string,string|undefined>;
const KNOWN=['mcphub','mcphub-oauth'];

/**
 * UBC_PLATFORM_ADAPTER selects an adapter: "mcphub", or "none" (explicit off,
 * wins over every legacy variable). Unset or empty: a deployment that still
 * sets UBC_PUBLIC_ORIGIN (exactly what used to enable self-service) keeps working
 * through the mcphub adapter with a deprecation warning; without it
 * there is no adapter (a stray UBC_HUB_URL alone is ignored with a warning).
 * mcphub: UBC_PUBLIC_ORIGIN (required, HTTPS origin users reach /ubc/ on),
 *         UBC_PLATFORM_URL (hub base for API calls, default UBC_PUBLIC_ORIGIN),
 *         UBC_PLATFORM_SERVER_NAME (hub server entry, default ubc-personal).
 * UBC_HUB_URL is accepted as a deprecated alias of UBC_PLATFORM_URL.
 * The "mcphub" adapter forwards the user's Hub session cookie and is DEPRECATED.
 * mcphub-oauth: OAuth 2.1 authorization code + PKCE instead of a forwarded cookie.
 *         Requires UBC_PLATFORM_URL, UBC_PUBLIC_ORIGIN (https, or http on loopback),
 *         UBC_OAUTH_CLIENT_ID and UBC_SESSION_SECRET (at least 32 bytes);
 *         optional UBC_OAUTH_CLIENT_SECRET and UBC_PLATFORM_SERVER_NAME.
 *         With UBC_MCP_HTTP=on it only signs users in (a token for the MCP resource,
 *         verified offline; no credential scope, no write to the platform) and keys accounts by UBC_OAUTH_ISSUER and
 *         UBC_OAUTH_SUBJECT_CLAIM, like the remote MCP endpoint.
 */
export function adapterFromEnv(store:Store,env:AdapterEnv=process.env,warn:(message:string)=>void=m=>console.error(m)):PlatformAdapter|null {
  let name=(env.UBC_PLATFORM_ADAPTER??'').trim().toLowerCase(),wasAuto=false;
  if(name==='none')return null;
  if(!name&&env.UBC_HUB_URL&&!env.UBC_PUBLIC_ORIGIN)
    warn('UBC_HUB_URL is set without UBC_PUBLIC_ORIGIN or UBC_PLATFORM_ADAPTER; it is ignored and platform self-service stays off.');
  if(!name&&env.UBC_PUBLIC_ORIGIN){
    warn('DEPRECATED: UBC_PUBLIC_ORIGIN is set without UBC_PLATFORM_ADAPTER, so the mcphub adapter is enabled automatically. Set UBC_PLATFORM_ADAPTER=mcphub explicitly (or UBC_PLATFORM_ADAPTER=none to disable); automatic enabling will be removed in a future release. The mcphub adapter forwards the user\'s Hub session cookie and is deprecated; migrate to UBC_PLATFORM_ADAPTER=mcphub-oauth.');
    name='mcphub';wasAuto=true;
  }
  if(!name)return null;
  if(!KNOWN.includes(name))throw new Error(`Unknown UBC_PLATFORM_ADAPTER "${name}". Supported: ${KNOWN.join(', ')}, none`);
  if(name==='mcphub-oauth') {
    const need=(key:string)=>{const v=env[key];if(!v)throw new Error(`UBC_PLATFORM_ADAPTER=mcphub-oauth requires ${key}`);return v;};
    const secret=env.UBC_OAUTH_CLIENT_SECRET;
    // With the remote MCP endpoint on, the platform reaches the connector through it, so this adapter only signs users in.
    const mcp=mcpConfigFromEnv(env);
    return mcphubOAuthAdapter(store,{origin:need('UBC_PUBLIC_ORIGIN'),platformUrl:need('UBC_PLATFORM_URL'),clientId:need('UBC_OAUTH_CLIENT_ID'),sessionSecret:need('UBC_SESSION_SECRET'),...(secret?{clientSecret:secret}:{}),...(mcp?{signInOnly:true,issuer:mcp.issuer,subjectClaim:mcp.subjectClaim,resource:mcp.resource,audience:mcp.audience,requireAtJwt:mcp.requireAtJwt}:{}),...(env.UBC_PLATFORM_SERVER_NAME?{serverName:env.UBC_PLATFORM_SERVER_NAME}:{}),warn});
  }
  const origin=env.UBC_PUBLIC_ORIGIN;
  if(!origin)throw new Error('UBC_PLATFORM_ADAPTER=mcphub requires UBC_PUBLIC_ORIGIN');
  if(!wasAuto)warn('DEPRECATED: the mcphub adapter forwards the user\'s Hub session cookie to the platform. Migrate to UBC_PLATFORM_ADAPTER=mcphub-oauth (OAuth 2.1 with PKCE); see the README.');
  const platformUrl=env.UBC_PLATFORM_URL||env.UBC_HUB_URL||undefined,serverName=env.UBC_PLATFORM_SERVER_NAME||undefined;
  return mcphubAdapter(store,{origin,...(platformUrl?{platformUrl}:{}),...(serverName?{serverName}:{})});
}
