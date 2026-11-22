import {readFileSync} from 'node:fs';
/**
 * The one-click Hub is whatever the manifest's page bridge runs on, so the manifest is the only
 * place that names it and src/ stays platform-neutral. Builds pass it to esbuild as a define.
 */
export function defaultHub(manifestPath='extension/manifest.json'){
  const match=JSON.parse(readFileSync(manifestPath,'utf8')).content_scripts?.find(c=>c.js?.includes('bridge.js'))?.matches?.[0];
  return match?new URL(match.replace(/\*$/,'')).origin:'';
}
export const hubDefine=(manifestPath)=>({__UBC_DEFAULT_HUB__:JSON.stringify(defaultHub(manifestPath))});
