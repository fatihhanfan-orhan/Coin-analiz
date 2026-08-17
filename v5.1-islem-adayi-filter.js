/* V5.1 TEST — yalnız işlem yapılabilir adayları göster */
(()=>{
'use strict';
function isActionable(x){if(!x?.rpot?.eligible)return false;try{const st=entryState({...x,s:score(x.m,x.h,x.p)},x.name);return !['BROKEN','LATE','STALE'].includes(st?.key);}catch{return true;}}
if(typeof findDaily3==='function'){
 const base=findDaily3;
 window.findDaily3=async(opts={})=>{
   const raw=await base(opts);
   const good=(raw||[]).filter(isActionable).slice(0,3);
   const grid=document.getElementById('candidateGrid'),status=document.getElementById('scanStatus');
   if(!good.length&&grid)grid.innerHTML='<div class="watchEmpty">🔴 Şu anda kriterlerimize uyan işlem yapılabilir fırsat yok.<br><small>Geç kalınmış veya bozulmuş coinler listeyi doldurmak için gösterilmez.</small></div>';
   if(status)status.textContent=good.length===3?'✅ 3 işlem yapılabilir fırsat bulundu.':good.length?`🟡 Şu anda ${good.length} işlem yapılabilir fırsat var. Kalan kutular kötü adaylarla doldurulmadı.`:'🔴 Şu anda işlem kriterlerimizi geçen coin yok.';
   return good;
 };
 const b=document.getElementById('find3');if(b)b.onclick=()=>window.findDaily3();
}
console.info('V5.1 işlem-adayı filtresi aktif');
})();