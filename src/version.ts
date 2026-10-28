import {readFileSync} from 'node:fs';
// Single source of truth: package.json, which sits one level above dist/ in the
// package, in the container image and in the npm tarball.
export const VERSION:string=(()=>{
  try {
    const v=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
    if(typeof v==='string'&&v)return v;
  }catch{/* fall through */}
  return 'unknown';
})();
