// Transport/scheduling only. Eligibility is supplied by the existing V5.1 engine.
export const ALARM_RECIPIENTS = Object.freeze([
  '20086d0a-b694-4d98-aa52-c5cfdf81fd08',
  '90f81c0e-3c8d-40ef-860b-fd315861717d'
]);
export const ALARM_INTERVAL = 30_000;
export const ALARM_DURATION = 180_000;

export class CriticalAlarm {
  constructor(ctx, env, validate) {
    this.storage = ctx.storage; this.env = env; this.validate = validate; this.now = () => Date.now();
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return Response.json({ok:false}, {status:405});
    const body = await request.json().catch(() => ({}));
    if (path === '/start') return this.serial(() => this.start(body.coin));
    const state = await this.storage.get('state');
    if (!state || body.id !== state.id || body.token !== state.token || body.coin !== state.coin)
      return Response.json({ok:false}, {status:403});
    if (path === '/ack') {
      await this.storage.transaction(async tx => {
        const latest = await tx.get('state');
        if (latest?.id === body.id) await tx.put('state', {...latest, stopped:'OPENED'});
      });
      await this.storage.deleteAlarm();
      return Response.json({ok:true, stopped:true});
    }
    if (path === '/status') return Response.json({ok:true, active:!state.stopped && this.now()<state.expiresAt});
    return Response.json({ok:false}, {status:404});
  }
  async start(coin) {
    if (this.env.CRITICAL_ALARM_ENABLED !== 'true' || !/^[A-Z0-9]{2,20}$/.test(coin||''))
      return Response.json({ok:false, reason:'DISABLED'}, {status:503});
    let plan;
    try { plan = await this.validate(coin); } catch { plan = null; }
    if (!plan) { await this.stop('INVALID'); return Response.json({ok:true, started:false}); }
    const now = this.now(), old = await this.storage.get('state');
    const rank = plan.kind === 'BUY' ? 2 : plan.kind === 'CONDITIONAL' ? 1 : 0;
    if (!rank) return Response.json({ok:true, started:false});
    // No rearming a spent/opened/invalidated episode; only a genuine upgrade.
    if (old && now-old.startedAt < 86_400_000 && rank <= old.highestRank)
      return Response.json({ok:true, started:false, reason:'DEDUPLICATED'});
    const state = {coin, id:crypto.randomUUID(), token:crypto.randomUUID()+crypto.randomUUID(),
      kind:plan.kind, highestRank:rank, startedAt:now, expiresAt:now+ALARM_DURATION,
      nextAt:now, sequence:0, stopped:null, pending:null};
    await this.storage.put('state', state);
    await this.storage.setAlarm(now+1);
    await this.tick(plan);
    return Response.json({ok:true, started:true, id:state.id});
  }
  async stop(reason, id) {
    await this.storage.transaction(async tx => {
      const state = await tx.get('state');
      if (state && (!id || state.id===id) && !state.stopped) await tx.put('state', {...state, stopped:reason});
    });
    await this.storage.deleteAlarm();
  }
  async alarm() { return this.serial(() => this.tick()); }
  async tick(initialPlan) {
    let state = await this.storage.get('state');
    if (!state || state.stopped) { await this.storage.deleteAlarm(); return; }
    if (this.now()>=state.expiresAt) return this.stop('EXPIRED', state.id);
    if (this.now()<state.nextAt) { await this.storage.setAlarm(state.nextAt); return; }
    if (this.env.CRITICAL_ALARM_ENABLED!=='true') return this.stop('DISABLED',state.id);
    let plan;
    try { plan = initialPlan || await this.validate(state.coin); } catch { plan = null; }
    if (!plan || (state.kind==='BUY' && plan.kind!=='BUY') || !['BUY','CONDITIONAL'].includes(plan.kind))
      return this.stop('INVALID_OR_STALE',state.id);
    // A tap during a slow validation must win over the pending send.
    const latest = await this.storage.get('state');
    if (!latest || latest.id!==state.id || latest.stopped) return;
    state = latest;
    if (this.now()>=state.expiresAt) return this.stop('EXPIRED',state.id);
    if (!state.pending) {
      state.pending = crypto.randomUUID();
      await this.storage.put('state',state);
    }
    // Save the retry wake-up before I/O; reuse the same provider idempotency key.
    await this.storage.setAlarm(Math.min(this.now()+ALARM_INTERVAL,state.expiresAt));
    let response, result;
    try {
      response = await this.send(state,plan);
      result = await response.json();
    } catch { return; }
    if (!response.ok || !result.id || result.errors) return this.stop('PROVIDER_ERROR',state.id);
    await this.storage.transaction(async tx => {
      const current = await tx.get('state');
      if (!current || current.id!==state.id || current.stopped) return;
      await tx.put('state', {...current, pending:null, sequence:current.sequence+1,
        notificationId:result.id, nextAt:Math.min(this.now()+ALARM_INTERVAL,current.expiresAt)});
    });
    const after = await this.storage.get('state');
    if (after?.id===state.id && !after.stopped) await this.storage.setAlarm(after.nextAt);
  }
  async send(state,plan) {
    if (!this.env.ONESIGNAL_API_KEY || !this.env.ONESIGNAL_APP_ID) throw Error('Missing push secrets');
    const api = this.env.CRITICAL_ALARM_API;
    if (!['https://coin-analiz.fatihhanfan.workers.dev','https://coin-analiz-push-test.fatihhanfan.workers.dev'].includes(api))
      throw Error('Invalid alarm endpoint');
    const alarm = {coin:state.coin,id:state.id,token:state.token,expiresAt:state.expiresAt,api};
    const link = new URL(this.env.APP_URL || 'https://fatihhanfan-orhan.github.io/Coin-analiz/');
    link.hash = 'critical-alarm='+encodeURIComponent(JSON.stringify(alarm));
    const conditional = plan.kind==='CONDITIONAL';
    return fetch('https://api.onesignal.com/notifications', {
      method:'POST', signal:AbortSignal.timeout(8000),
      headers:{'Content-Type':'application/json',Authorization:`Key ${this.env.ONESIGNAL_API_KEY}`},
      body:JSON.stringify({app_id:this.env.ONESIGNAL_APP_ID,target_channel:'push',
        include_subscription_ids:[...ALARM_RECIPIENTS],
        headings:{en:`${this.env.ALARM_TEST_MODE==='true'?'TEST — İşlem sinyali değildir — ':''}${state.coin}/TRY — ${conditional?'KOŞULLU GİRİŞ HAZIR':'GİRİŞ UYGUN'}`},
        contents:{en:conditional?`Piyasa AL değil. Limit ${plan.entry}; stop ${plan.stop}; Ana D1 ${plan.target}; R/R ${plan.rr.toFixed(2)}. Dokununca alarm durur.`:
          `Piyasa ${plan.entry}; stop ${plan.stop}; Ana D1 ${plan.target}; R/R ${plan.rr.toFixed(2)}. Dokununca alarm durur.`},
        priority:10,ttl:0,web_push_topic:`v51-critical-${state.coin}`,
        idempotency_key:state.pending,url:link.href,data:{criticalAlarm:alarm}})
    });
  }
}
