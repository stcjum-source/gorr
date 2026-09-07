import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '..', 'gagebu.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.error(`✗ ${name}`); }
};
const has = (needle) => assert.ok(html.includes(needle), `missing ${JSON.stringify(needle)}`);
const declarations = text => Object.fromEntries(text.split(';').map(part => part.split(/:(.*)/s).slice(0, 2).map(value => value.trim())).filter(([property, value]) => property && value));
const palettes = () => {
  const roots = [...css.matchAll(/:root\s*\{([^{}]*)\}/g)].map(match => declarations(match[1]));
  return [roots[0], Object.assign({}, roots[0], roots[1])];
};
const computedStyle = selector => {
  const result = {};
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').map(value => value.trim()).includes(selector)) Object.assign(result, declarations(match[2]));
  }
  return result;
};
const resolveColor = (value, variables) => {
  const variable = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return variable ? resolveColor(variables[variable], variables) : value;
};
const contrast = (foreground, background) => {
  const luminance = color => {
    let hex = color.slice(1);
    if (hex.length === 3) hex = [...hex].map(char => char + char).join('');
    const channels = hex.match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + .05) / (darker + .05);
};

check('approved semantic color tokens exist', () => {
  has('--green:#16794b'); has('--red:#c64138'); has('--blue:#245ac1'); has('--nav:#1f2923');
});
check('redesigned surfaces retain a usable dark color scheme', () => {
  assert.match(html, /@media\(prefers-color-scheme:dark\)\{:root\{[\s\S]*?--dock:/);
  has('background:var(--dock)'); has('background:var(--segment)'); has('border-bottom:1px solid var(--line)');
});
check('mobile top bar has previous/next month controls and a year-month label', () => {
  has('class="month-nav"'); has('onclick="moveMonth(-1)"'); has('onclick="moveMonth(1)"'); has('id="monthLabel"');
});
check('available balance hero and consistent won formatter are present', () => {
  has('이번 달 사용 가능액'); has('class="balance-hero'); has("toLocaleString('ko-KR')+'원'");
});
check('four-item bottom navigation exposes summary history fixed and year', () => {
  has('class="bottom-nav"');
  for (const label of ['요약', '내역', '고정', '연간']) has(`>${label}</button>`);
});
check('income category and person controls remain accessible', () => {
  has("setV('income')"); has("setV('cat')"); has("setPerson('권능')"); has('id="catFilter"');
});
check('interactive controls meet the 44px touch-target rule without resizing choice inputs', () => {
  assert.match(html, /button,input:not\(\[type=checkbox\]\):not\(\[type=radio\]\),select,textarea\{[^}]*min-height:44px/);
  assert.doesNotMatch(html, /button,input,select,textarea\{[^}]*min-height:44px/);
});
check('summary uses a simplified calculation stack', () => {
  has('class="summary-calc"'); has('현재 사용 가능액'); has('고정지출 구성');
});
check('summary keeps total-asset and family-note editors accessible', () => {
  assert.match(html, /<button[^>]*onclick="editAsset\(\)"[^>]*>총자산 수정/);
  assert.match(html, /<button[^>]*onclick="editFamilyNote\(\)"[^>]*>가족 메모 수정/);
});
check('fixed expenses are view-first with explicit edit mode and save bar', () => {
  has('fixedEdit:false'); has('function toggleFixedEdit()'); has('고정지출 관리'); has('class="fixed-save-dock"');
});
check('fixed editing is an isolated draft until save', () => {
  has('fixedDraft:null');
  has('function createFixedDraft('); has('function setFixedDraftField('); has('function fixedDraftPayload(');
  assert.match(html, /function beginFixedEdit\(\)[\s\S]*?getFixedForMonth\(S\.month\)[\s\S]*?getSavForMonth\(S\.month\)/);
  assert.match(html, /oninput="setFixedDraftField\(S\.fixedDraft,'fixed'/);
  assert.match(html, /oninput="setFixedDraftField\(S\.fixedDraft,'savings'/);
  assert.match(html, /function addFixed\(tag\)[\s\S]*?S\.fixedDraft[\s\S]*?render\(\)/);
  assert.match(html, /function delFixed\(id\)[\s\S]*?S\.fixedDraft[\s\S]*?render\(\)/);
  assert.match(html, /function addSaving\(\)[\s\S]*?S\.fixedDraft[\s\S]*?render\(\)/);
  assert.match(html, /function delSaving\(id\)[\s\S]*?S\.fixedDraft[\s\S]*?render\(\)/);
  assert.match(html, /function cancelFixedEdit\(\)\{S\.fixedEdit=false;S\.fixedDraft=null;render\(\);\}/);
  has('const fixedDraftTotal=fi.reduce');
  assert.match(html, /function goMonth\(m\)[^\n]*S\.fixedDraft=null/);
});
check('fixed draft helpers clone rows and produce names plus monthly maps', () => {
  const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function saveFixed'));
  const context={localStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(){},scrollY:0,scrollTo(){}},document:{addEventListener(){}},console,Date,Math,JSON,Number,String,Array,Object,Set,Map,RegExp,URLSearchParams,crypto:{randomUUID:()=> 'test-id'}};
  vm.createContext(context); vm.runInContext(script,context);
  const result=vm.runInContext(`(()=>{const sourceF=[{id:'f1',name:'Rent',amt:100,tag:'공통'}],sourceS=[{id:'s1',name:'Save',amt:50}];const draft=createFixedDraft(sourceF,sourceS);setFixedDraftField(draft,'fixed','f1','name','Rent 2');setFixedDraftField(draft,'fixed','f1','amt','125');appendFixedDraftItem(draft,'savings',{id:'s2',name:'Invest',amt:75});removeFixedDraftItem(draft,'savings','s1');const payload=fixedDraftPayload(draft,sourceF,sourceS);return {sourceF,sourceS,draft,payload};})()`,context);
  assert.equal(result.sourceF[0].name,'Rent');
  assert.equal(result.sourceS.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload)),{fixed:[{id:'f1',name:'Rent 2',amt:100,tag:'공통'}],savings:[{id:'s2',name:'Invest',amt:75}],fixedMap:{f1:125},savingsMap:{s2:75}});
});
check('empty expense state has an explicit primary CTA', () => {
  has('아직 등록된 지출이 없어요'); has('첫 지출 추가하기'); has('onclick="openForm(null)"');
});
check('green CTA foreground meets WCAG AA contrast in light and dark palettes', () => {
  const addSavingStyle = declarations(html.match(/<button onclick="addSaving\(\)" style="([^"]+)"/)?.[1] ?? '');
  for (const [name, style] of [['.empty-cta', computedStyle('.empty-cta')], ['add-saving button', addSavingStyle]]) {
    for (const [index, variables] of palettes().entries()) {
      const ratio = contrast(resolveColor(style.color, variables), resolveColor(style.background, variables));
      assert.ok(ratio >= 4.5, `${name} ${index ? 'dark' : 'light'} contrast is ${ratio.toFixed(2)}:1`);
    }
    assert.equal(style.color, 'var(--on-green)', `${name} must use --on-green`);
  }
});
check('sharing-code copy matches validation rules', () => {
  has('영문·숫자·_·- 조합으로 3~20자');
  assert.ok(!html.includes('아무 단어나 괜찮아요!'), 'misleading unrestricted-code copy remains');
});
check('Google Vision text with missing signs and won units still imports every Money transaction', () => {
  const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function parseTransactions'));
  const context={localStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(){},scrollY:0,scrollTo(){}},document:{addEventListener(){},querySelector(){return null}},console,Date,Math,JSON,Number,String,Array,Object,Set,Map,RegExp,URLSearchParams,crypto:{randomUUID:()=> 'test-id'}};
  vm.createContext(context); vm.runInContext(script,context);
  const visionText=`6:19
Busan
<
머니 2
egood
NELTE || 39
16,284원
전체
충전
사용
9월
GS25수영광안점
2026.9.7. 오후 12:53:28
머니+포인트 결제
ET
-8,706원
결제
코페이_키오스크_1
2026.9.7. 오후 12:09:32
머니+포인트 결제
-58,984
결제
메가엠지씨커피 강남중앙점
3,287원
2026.9.6. 오전 9:16:03
결제
머니+포인트 결제
코리아세븐강남중앙점
-2,673원
2026.9.6. 오전 9:15:11
결제
머니+포인트 결제
의신상회
2026.9.5. 오후 1:18:30
머니+포인트 결제
5,493원
결제
씨유 광장시장점
2026.9.5. 오후 12:26:12
머니+포인트 결제
1,501원
결제`;
  const parsed=vm.runInContext(`parseTransactions(${JSON.stringify(visionText)},8)`,context);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.items.map(({date,name,amt})=>({date,name,amt})))),[
    {date:'2026-09-07',name:'GS25수영광안점',amt:8706},
    {date:'2026-09-07',name:'코페이_키오스크_1',amt:58984},
    {date:'2026-09-06',name:'메가엠지씨커피 강남중앙점',amt:3287},
    {date:'2026-09-06',name:'코리아세븐강남중앙점',amt:2673},
    {date:'2026-09-05',name:'의신상회',amt:5493},
    {date:'2026-09-05',name:'씨유 광장시장점',amt:1501}
  ]);
});

check('Money parser does not turn an explicit positive credit into an expense', () => {
  const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function parseTransactions'));
  const context={localStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(){},scrollY:0,scrollTo(){}},document:{addEventListener(){},querySelector(){return null}},console,Date,Math,JSON,Number,String,Array,Object,Set,Map,RegExp,URLSearchParams,crypto:{randomUUID:()=> 'test-id'}};
  vm.createContext(context); vm.runInContext(script,context);
  const parsed=vm.runInContext(`parseTransactions('머니+포인트 결제\\n환불 상점\\n2026.9.8. 오후 1:00:00\\n+10,000원\\n결제',8)`,context);
  assert.equal(parsed.items.length,0);
});

check('Money parser keeps a merchant and amount that OCR places on one line', () => {
  const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function parseTransactions'));
  const context={localStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(){},scrollY:0,scrollTo(){}},document:{addEventListener(){},querySelector(){return null}},console,Date,Math,JSON,Number,String,Array,Object,Set,Map,RegExp,URLSearchParams,crypto:{randomUUID:()=> 'test-id'}};
  vm.createContext(context); vm.runInContext(script,context);
  const parsed=vm.runInContext(`parseTransactions('머니+포인트 결제\\n테스트상점 -12,300원\\n2026.9.8. 오후 1:00:00\\n결제',8)`,context);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.items.map(({date,name,amt})=>({date,name,amt})))),[
    {date:'2026-09-08',name:'테스트상점',amt:12300}
  ]);
});

check('Money parser keeps cancellation markers inside their own transaction block', () => {
  const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function parseTransactions'));
  const context={localStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(){},scrollY:0,scrollTo(){}},document:{addEventListener(){},querySelector(){return null}},console,Date,Math,JSON,Number,String,Array,Object,Set,Map,RegExp,URLSearchParams,crypto:{randomUUID:()=> 'test-id'}};
  vm.createContext(context); vm.runInContext(script,context);
  const text='머니+포인트 결제\n정상상점\n2026.9.8. 오후 1:00:00\n-1,000원\n다음상점\n2026.9.9. 오후 1:00:00\n결제 취소\n-2,000원';
  const parsed=vm.runInContext(`parseTransactions(${JSON.stringify(text)},8)`,context);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.items.map(({date,name,amt})=>({date,name,amt})))),[
    {date:'2026-09-08',name:'정상상점',amt:1000}
  ]);
});

check('Money parser rejects non-finite or unsafe OCR amounts', () => {
  const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function parseTransactions'));
  const context={localStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(){},scrollY:0,scrollTo(){}},document:{addEventListener(){},querySelector(){return null}},console,Date,Math,JSON,Number,String,Array,Object,Set,Map,RegExp,URLSearchParams,crypto:{randomUUID:()=> 'test-id'}};
  vm.createContext(context); vm.runInContext(script,context);
  const huge='9'.repeat(400);
  const text=`머니+포인트 결제\n오인식상점\n2026.9.8. 오후 1:00:00\n${huge}원\n결제`;
  const parsed=vm.runInContext(`parseTransactions(${JSON.stringify(text)},8)`,context);
  assert.equal(parsed.items.length,0);
});

check('Firebase keys and existing feature entry points are preserved', () => {
  for (const token of [
    'gorr-66f73', "'gagebu_room'", "'fgm'+YY+'_'+m", "'sgm'+YY+'_'+m",
    'function saveExp()', 'function saveInc()', 'function commitImport()',
    'function useFav(id)', 'function applyFilter()', 'function goMonth(m)'
  ]) has(token);
});

if (failures.length) {
  console.error(`\n${failures.length} assertion group(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll gagebu UI assertions passed.');
