/* V5.1 TEST — yalnız işlem yapılabilir adayları göster */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>Number.isFinite(Number(n))?Number(n).toFixed(d):'—';
function isActionable(x){
  if(!x?.rpot?.eligible)return false;
  try{
    const st=entryState({...x,s:score(x.m,x.h,x.p)},x.name);
    return !['BROKEN','LATE','STALE'].includes(st?.key);
  }catch{return true;}
}
function renderOnlyGood(raw){
  const good=(raw||[]).filter(isActionable).slice(0,3);
  lastScanCandidates=Object.fromEntries(good.map(x=>[x.name,x]));
  const grid=$('candidateGrid'),status=$('scanStatus');
  if(grid){
    if(!good.length){
      grid.innerHTML='<div class="watchEmpty">🔴 Şu anda kriterlerimize uyan işlem yapılabilir fırsat yok.<br><small>Geç kalınmış, desteği bozulmuş veya filtreyi geçemeyen coinler listeyi doldurmak için gösterilmez.</small></div>';
    }else{
      grid.innerHTML=good.map((x,i)=>{
        const tracked=loadWatch().includes(x.name);
        const st=entryState({...x,s:score(x.m,x.h,x.p)},x.name);
        const ratio=Number(x.vRatio||0);
        const vol=ratio>=1.5?'ÇOK GÜÇLÜ':ratio>=1.1?'GÜÇLÜ':ratio>=.8?'NORMAL':'ZAYIF';
        const dir=Number(x.m?.price)>=Number(x.m?.lastOpen)?'ALIM YÖNLÜ':'SATIŞ YÖNLÜ';
        const sp=Number(x.spread);
        const spTxt=Number.isFinite(sp)?`%${fmt(sp,3)} • ${sp<=.20?'UYGUN':sp<=.35?'SINIRDA':'YÜKSEK'}`:'VERİ YOK';
        return `<div class="cand"><b>🟢 İŞLEM ADAYI • ${i+1}. ${x.name}/TRY</b><div class="statePill ${st.tone}">${st.label}</div><div class="cp ${x.candidate>=75?'good':x.candidate>=60?'mid':''}">${fmt(x.candidate,0)}/100</div><small>Desteğe mesafe: ${x.p.dist>0?'+':''}${fmt(x.p.dist,2)}%</small><small>Dönüş teyidi: ${x.p.bounce?'VAR':'BEKLENİYOR'}</small><small>15 dk hacim: ${fmt(ratio,2)}× MA5 • ${vol} • ${dir}</small><small>Spread (Alış–Satış Farkı): ${spTxt}</small><div class="respot"><b>DİRENCE ULAŞMA POTANSİYELİ</b><strong class="${potentialClass(x.rpot.score)}">${fmt(x.rpot.score,1)}/10</strong><small>Direnç-1 kâr alanı: +${fmt(x.rpot.upside1,2)}% • Direnç-1: ${fmt(x.rpot.t1,6)}</small><small>Desteğe uzaklık: ${fmt(Math.abs(x.p.dist),2)}% • Risk 1 → Kazanç ${fmt(Math.max(0,x.rpot.rr),2)}</small></div><button class="trackBtn ${tracked?'tracked':''}" ${tracked?'disabled':''} onclick="trackOpportunity('${x.name}',this)">${tracked?'✅ TAKİPTE':'👁️ TAKİBE AL'}</button></div>`;
      }).join('');
    }
  }
  if(status){
    status.textContent=good.length===3?'✅ 3 işlem yapılabilir fırsat bulundu. Yalnızca kriterleri geçen coinler gösteriliyor.':good.length?`🟡 Şu anda ${good.length} işlem yapılabilir fırsat var. Eksik kutular kötü/geç kalınmış adaylarla doldurulmadı.`:'🔴 Şu anda işlem kriterlerimizi geçen coin yok. Geç kalınmış veya bozulmuş aday gösterilmedi.';
  }
  return good;
}
if(typeof findDaily3==='function'){
  const base=findDaily3;
  window.findDaily3=async(opts={})=>renderOnlyGood(await base(opts));
  const b=$('find3');if(b)b.onclick=()=>window.findDaily3();
}
console.info('V5.1 işlem-adayı filtresi aktif');
})();