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
