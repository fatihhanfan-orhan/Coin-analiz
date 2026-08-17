/* Coin Analiz V5.1 Paket A+B test patch — yalnız test sayfasında yüklenir. */
(()=>{
'use strict';
const byId=id=>document.getElementById(id);
const clean=v=>String(v||'').trim().toUpperCase().replace(/\/?TRY$/,'').replace(/[^A-Z0-9]/g,'');
let manualLiveCoin='';

/* Görsel okunabilirlik */
const st=document.createElement('style');
st.textContent=`
.refLine{display:block;margin-top:3px;color:#91a2b8;font-size:.82em;font-weight:650;line-height:1.25}
.miniLamp{font-size:9px;vertical-align:1px}.spreadGood{color:#31d158}.spreadMid{color:#ffbf2f}.spreadBad{color:#ff666d}
@media(max-width:720px){.coin-title{font-size:22px!important}.price{font-size:29px!important}.metric b,.planbox b,.liveBox b{font-size:10px!important}.metric span,.planbox span,.liveBox span{font-size:13px!important}.decision{font-size:24px!important}.why{font-size:13px!important}.whyicon{width:13px!important;flex-basis:13px!important}.planrow,.liveStrip{grid-template-columns:1fr 1fr!important}}
`;
document.head.appendChild(st);

/* Terminoloji */
if(typeof window.planUI==='function'){
 const base=window.planUI;
 window.planUI=(p,m,h)=>base(p,m,h)
  .replace('FİYAT / BÖLGE MESAFESİ','DESTEĞE MESAFE')
  .replace('STOP REFERANSI','STOP FİYATI')
  .replace('HEDEF 1 / HEDEF 2','DİRENÇ 1 / DİRENÇ 2')
  .replace('RİSK / KAZANÇ (H1)','RİSK 1 → KAZANÇ')
  .replace(/<span>1\s*:\s*([^<]+)<\/span>/,'<span>1 → $1</span>');
}

/* NEDEN satırlarında küçük trafik ışıkları */
if(typeof window.reasonRows==='function'){
 const base=window.reasonRows;
 window.reasonRows=(m,h,s)=>base(m,h,s)
   .replaceAll('✅','🟢').replaceAll('⚠️','🟡');
}

/* RSI / MACD: ham değer yanında kısa anlam */
if(typeof window.metric==='function'){
 const base=window.metric;
 window.metric=(n,v)=>{
   let out=base(n,v),x=Number(String(v).replace(',','.'));
   if(n==='RSI 14'&&Number.isFinite(x)){
     const t=x<30?'AŞIRI SATIM':x<50?'ZAYIF/NÖTR':x<=70?'NORMAL/GÜÇLÜ':'AŞIRI ALIM';
     out=out.replace('</span>',` → ${t}<small class="refLine">&lt;30 Aşırı Satım • 30–70 Normal • &gt;70 Aşırı Alım</small></span>`);
   }
   if(n==='MACD Hist'&&Number.isFinite(x))out=out.replace('</span>',` → ${x<0?'NEGATİF':'POZİTİF'}<small class="refLine">NEGATİF &lt; 0 &gt; POZİTİF</small></span>`);
   return out;
 };
}

/* Tek coin analiz edilen coin de canlı WS/REST havuzuna girer. */
if(typeof window.activeCoinNames==='function'){
 const base=window.activeCoinNames;
 window.activeCoinNames=()=>[...new Set([...(base()||[]),manualLiveCoin].map(clean).filter(Boolean))];
}
if(typeof window.runManualCoin==='function'){
 const base=window.runManualCoin;
 window.runManualCoin=async()=>{
   manualLiveCoin=clean(byId('manualCoin')?.value);
   const r=await base();
   /* ikinci manuel pozisyon butonunu kaldır; kartın canlı ASK butonu tek giriş olsun */
   const box=byId('manualResult');
   if(box){[...box.children].forEach(el=>{if(el.tagName==='BUTTON'&&!el.classList.contains('quickBuyBtn'))el.remove()});}
   try{window.startMarketWS?.();if(manualLiveCoin)window.fetchPositionDepthSnapshot?.(manualLiveCoin)}catch{}
   return r;
 };
 const b=byId('manualRun');if(b)b.onclick=window.runManualCoin;
}

/* Spread verisi yoksa %99 üretme: bir kez canlı book ile tekrar dene, yoksa NaN = geçersiz. */
if(typeof window.candidateMetrics==='function'){
 const base=window.candidateMetrics;
 window.candidateMetrics=async(name,t24,bookMap)=>{
   const x=await base(name,t24,bookMap);
   if(!Number.isFinite(x.spread)||x.spread>=90){
     try{const b=await window.liveBook(name);x.spread=b.spread;if(b.ask>0){x.m.price=b.ask;x.m.bid=b.bid;x.m.ask=b.ask}}catch{x.spread=NaN}
     x.rpot=window.resistancePotential(x);
   }
   return x;
 };
}

/* Canlı spreadi kullanıcıya anlamlı göster. */
if(typeof window.updateLiveDom==='function'){
 const base=window.updateLiveDom;
 window.updateLiveDom=(name,patch={})=>{
   const r=base(name,patch),bid=Number(patch.bid),ask=Number(patch.ask),sid=clean(name);
   if(bid>0&&ask>0){
     const sp=(ask-bid)/((ask+bid)/2)*100,e=byId('spread_'+sid);
     if(e){const tone=sp<=.20?'spreadGood':sp<=.35?'spreadMid':'spreadBad',lab=sp<=.20?'UYGUN':sp<=.35?'SINIRDA':'YÜKSEK';e.className=tone;e.innerHTML=`%${sp.toFixed(3)} • ${lab}<small class="refLine">Alış–Satış Farkı • tahmini giriş maliyeti ≈ −%${sp.toFixed(3)}</small>`;}
   }
   return r;
 };
}

function volumeText(x){
 const ratio=Number(x.vRatio||0),up=Number(x.m?.price)>=Number(x.m?.lastOpen),dir=up?'ALIM YÖNLÜ':'SATIŞ YÖNLÜ';
 const strength=ratio>=1.5?'ÇOK GÜÇLÜ':ratio>=1.1?'GÜÇLÜ':ratio>=.8?'NORMAL':'ZAYIF';
 return `${ratio.toFixed(2)}× MA5 • ${strength} • ${dir}`;
}
function spreadText(x){return Number.isFinite(x.spread)?`%${x.spread.toFixed(3)} • ${x.spread<=.20?'UYGUN':x.spread<=.35?'SINIRDA':'YÜKSEK'}`:'VERİ YOK • İŞLEME UYGUN DEĞİL';}

/* 3 kutuyu doldurmak için yedek/geç kalmış fırsat gösterme. */
if(typeof window.findDaily3==='function'){
 const base=window.findDaily3;
 window.findDaily3=async(opts={})=>{
   const raw=await base(opts);
   const winners=(raw||[]).filter(x=>x?.rpot?.eligible).slice(0,3);
   window.lastScanCandidates=Object.fromEntries(winners.map(x=>[x.name,x]));
   const grid=byId('candidateGrid'),status=byId('scanStatus');
   if(grid){
     grid.innerHTML=winners.length?winners.map((x,i)=>{
       const tracked=window.loadWatch().includes(x.name),state=window.entryState({...x,s:window.score(x.m,x.h,x.p)},x.name);
       return `<div class="cand"><b>🟢 İŞLEM ADAYI • ${i+1}. ${x.name}/TRY</b><div class="statePill ${state.tone}">${state.label}</div><div class="cp ${x.candidate>=75?'good':x.candidate>=60?'mid':''}">${x.candidate.toFixed(0)}/100</div><small>Desteğe mesafe: ${x.p.dist>0?'+':''}${x.p.dist.toFixed(2)}%</small><small>Dönüş teyidi: ${x.p.bounce?'VAR':'BEKLENİYOR'}</small><small>15 dk hacim: ${volumeText(x)}</small><small>Spread (Alış–Satış Farkı): ${spreadText(x)}</small><div class="respot"><b>DİRENCE ULAŞMA POTANSİYELİ</b><strong class="${window.potentialClass(x.rpot.score)}">${x.rpot.score.toFixed(1)}/10</strong><small>Direnç-1 kâr alanı: +${x.rpot.upside1.toFixed(2)}% • Direnç-1: ${window.fmt(x.rpot.t1,6)}</small><small>Desteğe uzaklık: ${Math.abs(x.p.dist).toFixed(2)}% • Risk 1 → Kazanç ${Math.max(0,x.rpot.rr).toFixed(2)}</small></div><button class="trackBtn ${tracked?'tracked':''}" ${tracked?'disabled':''} onclick="trackOpportunity('${x.name}',this)">${tracked?'✅ TAKİPTE':'👁️ TAKİBE AL'}</button></div>`;
     }).join(''):'<div class="watchEmpty">Şu anda kriterlerimize uyan işlem yapılabilir fırsat bulunamadı. Sistem kutuları doldurmak için geç kalınmış veya bozulmuş coin göstermedi.</div>';
   }
   if(status){status.textContent=winners.length===3?'✅ 3 işlem yapılabilir fırsat bulundu.':winners.length?`🟡 Şu anda yalnız ${winners.length} işlem yapılabilir fırsat var. Eksik kutular kötü adayla doldurulmadı.`:'🔴 Şu anda işlem kriterlerimizi geçen coin yok. Geç kalınmış/yedek aday gösterilmedi.';}
   return winners;
 };
 const f=byId('find3');if(f)f.onclick=()=>window.findDaily3();
}

/* Kart başlığındaki spread ifadesini anlaşılırlaştır. */
setTimeout(()=>{
 document.querySelectorAll('.liveBox b').forEach(b=>{if(b.textContent.trim()==='SPREAD')b.innerHTML='SPREAD <small style="font-size:9px">(Alış–Satış Farkı)</small>';});
},500);

console.info('Coin Analiz V5.1 Paket A+B test patch aktif');
})();