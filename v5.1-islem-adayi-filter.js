/* V5.1 TEST — yalnız gerçekten uygun işlem adaylarını göster */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
function eligible(x){return !!(x&&x.rpot&&x.rpot.eligible);}
function relabel(count){
  const grid=$('candidateGrid');
  const finder=grid&&grid.closest('.finder');
  if(!finder)return;
  [...finder.querySelectorAll('h2,h3,b,strong')].forEach(el=>{
    const t=(el.textContent||'').trim();
    if(/BULUNAN\s+3\s+FIRSAT/i.test(t)) el.textContent=count?`✨ BULUNAN ${count} İŞLEM FIRSATI`:'✨ İŞLEM FIRSATI';
  });
}
if(typeof findDaily3==='function'){
  const base=findDaily3;
  window.findDaily3=async function(opts={}){
    const raw=await base(opts);
    const list=Array.isArray(raw)?raw:[];
    const keep=list.map(eligible);
    const good=list.filter(eligible).slice(0,3);
    const grid=$('candidateGrid'),status=$('scanStatus');

    if(grid){
      if(!good.length){
        grid.innerHTML='<div class="watchEmpty" style="grid-column:1/-1;padding:16px;text-align:center">🔴 <b>Şu anda kriterlerimize uyan işlem yapılabilir fırsat yok.</b><br><small>Geç kalınmış, desteği bozulmuş veya filtreyi geçemeyen coinler listeyi doldurmak için gösterilmez.</small></div>';
      }else{
        const cards=[...grid.children];
        cards.forEach((card,i)=>{if(i<keep.length&&!keep[i])card.remove();});
      }
    }

    relabel(good.length);
    if(status){
      status.textContent=good.length===3
        ?'✅ Tarama tamamlandı • 3 işlem yapılabilir fırsat bulundu.'
        :good.length
          ?`🟡 Tarama tamamlandı • ${good.length} işlem yapılabilir fırsat bulundu • liste kötü/yedek adaylarla tamamlanmadı.`
          :'🔴 Tarama tamamlandı • Şu anda işlem kriterlerimizi geçen coin yok • yedek aday gösterilmedi.';
    }
    return good;
  };
  const b=$('find3');
  if(b)b.onclick=()=>window.findDaily3();
}
console.info('V5.1 işlem-adayı filtresi aktif v2');
})();