export interface RawCard {label:string;summary:string;meetingLabels:string[];incompleteMeetings:boolean;sourceId:string|null;}
export interface RawDetails {label:string;fields:Record<string,string>;meetingLabels:string[];instructors:string[];reservedRules:Array<{rule:string;available:string;capacity:string}>;}
export interface RawCapture {periodLabel:string;cards:RawCard[];details:RawDetails|null;capturedAt:string;}

// Self-contained so Chrome can inject this read-only function into the active tab.
// It reads course cards and a section detail dialog, never cookies, storage or profile headers.
export function extractWorkdayDom():RawCapture {
  const clean=(s:string|null|undefined)=>(s??'').replace(/\s+/g,' ').trim();
  const visible=(el:Element)=>el.getClientRects().length>0&&el.getAttribute('aria-hidden')!=='true';
  const coursePattern=/^[A-Z]{2,6}_[VO] \d{3}[A-Z]?-[A-Z0-9]+ - /;
  const prompts=(root:ParentNode)=>Array.from(root.querySelectorAll('[data-automation-id="promptOption"]'));
  const cards:RawCard[]=[];
  for(const root of document.querySelectorAll('[data-automation-id="compositeContainer"]')) {
    if(!visible(root))continue;
    const label=clean(prompts(root).find(e=>coursePattern.test(clean(e.textContent)))?.textContent);
    if(!label)continue;
    const summary=Array.from(root.querySelectorAll('[aria-label]')).map(e=>e.getAttribute('aria-label')??'').find(t=>t.includes('Enrolled/Capacity:'))??'';
    const fallback=clean(root.textContent).match(/(Lecture|Laboratory|Discussion|Tutorial|Seminar)\s*\|[\s\S]*?(?=Section Details|$)/)?.[0]??'';
    const prompt=prompts(root).find(e=>clean(e.textContent)===label);
    cards.push({label,summary:summary||fallback,
      meetingLabels:Array.from(root.querySelectorAll('[role="link"]')).filter(e=>visible(e)).map(e=>clean(e.textContent)).filter(t=>/^UBC[VO] \|/.test(t)),
      incompleteMeetings:/\+\d+ more/.test(root.textContent??''),
      sourceId:prompt?.closest('[data-automation-id^="selectedItem_"]')?.getAttribute('data-automation-id')?.replace('selectedItem_','')??null});
  }
  let details:RawDetails|null=null;
  const dialog=Array.from(document.querySelectorAll('[role="dialog"]')).find(el=>visible(el)&&
    Array.from(el.querySelectorAll('h2')).some(h=>clean(h.textContent)==='View Course Section'));
  if(dialog){
    const label=clean(prompts(dialog).find(el=>coursePattern.test(clean(el.textContent)))?.textContent);
    const fields:Record<string,string>={};let instructors:string[]=[],meetingLabels:string[]=[];
    for(const labelEl of dialog.querySelectorAll('[data-automation-id="formLabel"]')){
      const name=clean(labelEl.textContent),value=labelEl.closest('li')?.querySelector('[data-automation-id="decorationWrapper"]');
      if(!name||!value)continue;
      // Select only fields needed for course planning, excluding student-specific records.
      if(['Academic Period','Status','Total Section Capacity','Unreserved Seats Available','Reserved Seats Available','Eligibility','Instructional Formats','Other Instructional Formats','Delivery Mode','Campus'].includes(name))
        fields[name]=clean(value.textContent);
      if(name==='Instructor Teaching')instructors=prompts(value).map(e=>clean(e.textContent));
      if(name==='Meeting Patterns')meetingLabels=Array.from(value.querySelectorAll('[role="link"]')).map(e=>clean(e.textContent)).filter(t=>/^UBC[VO] \|/.test(t));
    }
    const table=Array.from(dialog.querySelectorAll('[role="table"],table')).find(t=>
      /Reserved Seats Available by Eligibility/.test(t.getAttribute('aria-label')??t.querySelector('caption')?.textContent??'')||
      ((t.textContent??'').includes('Eligibility Rule')&&(t.textContent??'').includes('Seat Capacity')));
    const reservedRules=table?Array.from(table.querySelectorAll('[role="row"],tr')).map(row=>{
      const cells=Array.from(row.querySelectorAll('[role="cell"],td')).map(c=>clean(c.textContent));
      return {rule:cells[0]??'',available:cells[1]??'',capacity:cells[2]??''};
    }).filter(r=>r.rule&&/^\d+$/.test(r.available)&&/^\d+$/.test(r.capacity)):[];
    if(label)details={label,fields,instructors,meetingLabels,reservedRules};
  }
  const periodLabel=details?.fields['Academic Period']??prompts(document).map(e=>clean(e.textContent)).find(t=>/^20\d{2}.*(?:Winter|Summer).*(?:UBC-[VO])/.test(t))??'';
  return {periodLabel,cards,details,capturedAt:new Date().toISOString()};
}
