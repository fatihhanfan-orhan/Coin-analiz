/* Coin Analiz V5.1 Paket A+B test patch — scan-safe sürüm */
(()=>{
'use strict';
const byId=id=>document.getElementById(id);
const clean=v=>String(v||'').trim().toUpperCase().replace(/\/?TRY$/,'').replace(/[^A-Z0-9]/g,'');
let manualLiveCoin='';
const st=document.createElement('style');
st.textContent=`.refLine{display:block;margin-top:3px;color:#91a2b8;font-size:.82em;font-weight:650