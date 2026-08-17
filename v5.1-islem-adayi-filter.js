/* V5.1 TEST — aktif işlem adayları + kâr önceliği + anlaşılır spread */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const DELISTED=new Set(['VIC']);
function isBadText(t){t=String(t||'').toUpperCase();return t.includes('YEDEK ADAY')||t.includes('FIRSAT BOZULDU')||t.includes('GEÇ KALINDI')||t.includes('DELIST');}
function isDelistedCard(t){t=String(t||'').toUpperCase();for(const s of DELISTED){if(t.includes(s+'/TRY'))return true;}return false;}
function pct(t,re){const m=String(t||'').match(re);return m?parseFloat(m[1].replace(',','.')):NaN;}
function profitOf(card){return pct(card.textContent,/Gerçek\s+Direnç-1\s+alanı:\s*\+?([\d.,]+)%/i);}
function spreadLabel(v){if(v<=0.10)return '🟢 DÜŞÜK / İYİ';if(v<=0.20)return '🟢 UYGUN';if(v<=0.35)return '🟡 DİKKAT';return '🔴 YÜKSEK – ALIM İÇİN UYGUN DEĞİL';}
function enhanceSpread(card){
  const els=[...card.querySelectorAll('*')];
  const el=els.find(x=>/^Spread:\s*[\d.,]+%/i.test((x.textContent||'').trim()) && x.children.length===0);
  if(!el)return;
  const m=(el.textContent||'').match(/Spread:\s*([\d.,]+)%/i);if(!m)return;
  const v=parseFloat(m[1].replace(',','.'));if(!Number.isFinite(v))return;
  el.textContent=`Spread: ${m[1]}% • ${spreadLabel(v)}`;
}
function addProfitBadge(card){
  const p=profitOf(card);if(!Number.isFinite(p))return;
  let b=card.querySelector('.v51ProfitBadge');
  if(!b){b=document.createElement('div');b.className='v51ProfitBadge';b.style.cssText='margin:6px 0;font-weight:800;color:#7CFF8A';const box=card.querySelector('.candScore')||card.children[1];if(box&&box.parentNode)box.parentNode.insertBefore(b,box.nextSibling);else card.prepend(b);}
  b.textContent=`💰 KÂR POTANSİYELİ: +${p.toFixed(2)}%`;
}
function cleanupCards(){
 const grid=$('candidateGrid'),status=$('scanStatus');if(!grid)return;
 [...grid.children].forEach(card=>{const t=card.textContent||'';if(isBadText(t)||isDelistedCard(t))card.remove();});
 let remain=[...grid.children].filter(x=>x.classList.contains('cand'));
 remain.forEach(c=>{enhanceSpread(c);addProfitBadge(c);});
 remain.sort((a,b)=>(profitOf(b)||-999)-(profitOf(a)||-999)).forEach(c=>grid.appendChild(c));
 remain=[...grid.children].filter(x=>x.classList.contains('cand'));
 remain.forEach((c,i)=>{const title=[...c.querySelectorAll('*')].find(x=>/FIRSAT\s*•\s*\d+\./i.test(x.textContent||'')&&x.children.length===0);if(title)title.textContent=title.textContent.replace(/FIRSAT\s*•\s*\d+\./i,`FIRSAT • ${i+1}.`);});
 if(!remain.length){grid.innerHTML='<div class="watchEmpty" style="grid-column:1/-1;padding:16px;text-align:center">🔴 <b>Şu anda kriterlerimize uyan işlem yapılabilir fırsat yok.</b><br><small>Delist olmuş, geç kalınmış, bozulmuş veya yalnız yedek olan coinler gösterilmez.</small></div>';if(status)status.textContent='🔴 Tarama tamamlandı • Şu anda işlem kriterlerimizi geçen aktif coin yok.';}
 else if(status)status.textContent=`✅ Tarama tamamlandı • ${remain.length} aktif fırsat • sıralama gerçek Direnç-1 kâr potansiyeline göre yapıldı.`;
 const finder=grid.closest('.finder');if(finder){[...finder.querySelectorAll('h2,h3,b,strong')].forEach(el=>{if(/BULUNAN\s+\d+\s+(FIRSAT|İŞLEM FIRSATI)/i.test((el.textContent||'').trim()))el.textContent=remain.length?`✨ BULUNAN ${remain.length} İŞLEM FIRSATI`:'✨ İŞLEM FIRSATI';});}
}
function attachObserver(){const grid=$('candidateGrid');if(!grid)return;let busy=false;const obs=new MutationObserver(()=>{if(busy)return;busy=true;setTimeout(()=>{cleanupCards();busy=false;},0);});obs.observe(grid,{childList:true,subtree:false});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attachObserver);else attachObserver();
if(typeof findDaily3==='function'){const base=findDaily3;window.findDaily3=async function(opts={}){const r=await base(opts);cleanupCards();return r;};const b=$('find3');if(b)b.onclick=()=>window.findDaily3();}
console.info('V5.1 kâr önceliği + spread etiketi aktif v4');
})();