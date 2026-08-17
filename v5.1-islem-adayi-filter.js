/* V5.1 TEST — yalnız gerçekten uygun, aktif işlem adaylarını göster */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const DELISTED=new Set(['VIC']);
function isBadText(t){
  t=String(t||'').toUpperCase();
  return t.includes('YEDEK ADAY')||t.includes('FIRSAT BOZULDU')||t.includes('GEÇ KALINDI')||t.includes('DELIST');
}
function isDelistedCard(t){
  t=String(t||'').toUpperCase();
  for(const s of DELISTED){if(t.includes(s+'/TRY'))return true;}
  return false;
}
function cleanupCards(){
  const grid=$('candidateGrid'),status=$('scanStatus');
  if(!grid)return;
  const cards=[...grid.children];
  cards.forEach(card=>{
    const t=card.textContent||'';
    if(isBadText(t)||isDelistedCard(t))card.remove();
  });
  const remain=[...grid.children].filter(x=>x.classList.contains('cand'));
  if(!remain.length){
    grid.innerHTML='<div class="watchEmpty" style="grid-column:1/-1;padding:16px;text-align:center">🔴 <b>Şu anda kriterlerimize uyan işlem yapılabilir fırsat yok.</b><br><small>Delist olmuş, geç kalınmış, bozulmuş veya yalnız yedek olan coinler gösterilmez.</small></div>';
    if(status)status.textContent='🔴 Tarama tamamlandı • Şu anda işlem kriterlerimizi geçen aktif coin yok • yedek/delist aday gösterilmedi.';
  }else{
    if(status)status.textContent=`✅ Tarama tamamlandı • ${remain.length} işlem yapılabilir aktif fırsat gösteriliyor • yedek/delist adaylar elendi.`;
  }
  const finder=grid.closest('.finder');
  if(finder){
    [...finder.querySelectorAll('h2,h3,b,strong')].forEach(el=>{
      const t=(el.textContent||'').trim();
      if(/BULUNAN\s+3\s+FIRSAT/i.test(t))el.textContent=remain.length?`✨ BULUNAN ${remain.length} İŞLEM FIRSATI`:'✨ İŞLEM FIRSATI';
    });
  }
}
function attachObserver(){
  const grid=$('candidateGrid');
  if(!grid)return;
  const obs=new MutationObserver(()=>setTimeout(cleanupCards,0));
  obs.observe(grid,{childList:true,subtree:false});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attachObserver);else attachObserver();

/* Mevcut fonksiyon çağrısından sonra da temizle. */
if(typeof findDaily3==='function'){
  const base=findDaily3;
  window.findDaily3=async function(opts={}){
    const r=await base(opts);
    cleanupCards();
    return r;
  };
  const b=$('find3');
  if(b)b.onclick=()=>window.findDaily3();
}
console.info('V5.1 aktif/yedek/delist filtresi aktif v3');
})();