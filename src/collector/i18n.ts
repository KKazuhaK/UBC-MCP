import {zh} from './i18n-zh.js';

/**
 * The extension speaks the browser's language: Chinese for a Chinese browser, English otherwise.
 * Strings are keyed by their English text, so English needs no table and anything without a
 * translation stays English. `{name}` placeholders are filled from `vars`.
 */
export type Lang='en'|'zh';
export function detectLang():Lang {
  try {
    const g=globalThis as unknown as {browser?:typeof chrome;chrome?:typeof chrome;navigator?:{language?:string}};
    const ui=(g.browser??g.chrome)?.i18n?.getUILanguage?.()??g.navigator?.language??'en';
    return String(ui).toLowerCase().startsWith('zh')?'zh':'en';
  }catch{return 'en';}
}
let lang:Lang|undefined;
export const currentLang=():Lang=>lang??=detectLang();
/** For tests: pick the language instead of asking the browser. */
export const setLang=(value:Lang|undefined):void=>{lang=value;};
export function t(text:string,vars?:Record<string,string|number>):string {
  const s=currentLang()==='zh'?(zh[text]??text):text;
  return vars?s.replace(/\{(\w+)\}/g,(m,k:string)=>k in vars?String(vars[k]):m):s;
}
/**
 * Translates a page: `data-i18n` elements get their own English text translated, `data-i18n-html`
 * ones get markup from the (constant) translation table, and `data-i18n-placeholder` and
 * `data-i18n-label` translate those attributes.
 */
export function localizeDocument(doc:Document):void {
  doc.documentElement.setAttribute('lang',currentLang()==='zh'?'zh-CN':'en');
  if(currentLang()==='en')return;
  doc.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el=>{el.textContent=t((el.textContent??'').trim());});
  doc.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach(el=>{el.innerHTML=t(el.innerHTML.trim());});
  doc.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach(el=>{const v=el.getAttribute('placeholder');if(v)el.setAttribute('placeholder',t(v));});
  doc.querySelectorAll<HTMLElement>('[data-i18n-label]').forEach(el=>{const v=el.getAttribute('aria-label');if(v)el.setAttribute('aria-label',t(v));});
  const title=doc.querySelector('title');if(title?.textContent)title.textContent=t(title.textContent.trim());
}
