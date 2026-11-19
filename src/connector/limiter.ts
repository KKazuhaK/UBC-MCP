/**
 * Fixed-window counters keyed by string, with a hard cap on the number of keys.
 * At the cap the oldest window is evicted (Map insertion order), so there is never a scan and memory stays bounded.
 */
export class Limiter {
  private windows=new Map<string,{count:number;until:number}>();
  constructor(private max=10_000,private windowMs=60_000){}
  get size(){return this.windows.size;}
  get(key:string,now:number){
    const prev=this.windows.get(key);
    if(prev&&prev.until>now)return prev;
    if(prev)this.windows.delete(key);
    else if(this.windows.size>=this.max)this.windows.delete(this.windows.keys().next().value as string);
    const fresh={count:0,until:now+this.windowMs};this.windows.set(key,fresh);return fresh;
  }
}

/**
 * Limiter key for a client address: IPv4 as is, IPv4-mapped IPv6 as its IPv4 address, other IPv6 by its /64
 * (one subscriber usually holds a whole /64, so per-address keys would be free to rotate).
 */
export function clientKey(address:string):string {
  const bare=(address.split('%')[0]??'').toLowerCase();
  const mapped=/^(?:0{0,4}:){2,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)??/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if(mapped?.[1])return mapped[1];
  if(!bare.includes(':'))return bare;
  let head=bare,tail='';
  const gap=bare.indexOf('::');
  if(gap>=0){head=bare.slice(0,gap);tail=bare.slice(gap+2);}
  const groups=(text:string)=>text?text.split(':'):[];
  const first=groups(head),last=groups(tail);
  if(gap<0&&first.length!==8)return bare;
  const all=gap>=0?[...first,...Array<string>(Math.max(0,8-first.length-last.length)).fill('0'),...last]:first;
  return all.slice(0,4).map(g=>(parseInt(g||'0',16)||0).toString(16)).join(':')+'::/64';
}
