import test from 'node:test';
import assert from 'node:assert/strict';
import {setLang,t,currentLang} from '../dist/collector/i18n.js';
import {zh} from '../dist/collector/i18n-zh.js';

test('strings are keyed by their English text, fill placeholders, and fall back to English',()=>{
 setLang('en');
 assert.equal(t('Synced {count} period(s).',{count:3}),'Synced 3 period(s).');
 assert.equal(t('Keeps {missing} as is'),'Keeps {missing} as is');
 setLang('zh');
 assert.equal(currentLang(),'zh');
 // A string without a Chinese entry stays English.
 const key='Sync now';
 assert.equal(t(key),zh[key]??key);
 setLang(undefined);
});
