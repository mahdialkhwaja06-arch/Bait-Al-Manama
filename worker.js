/**
 * Bait Al-Manama — Cloudflare Worker
 * Serves static HTML files via ASSETS binding
 * Handles all /api/* routes via KV storage
 */

// ── Web Push (Chrome notifications — no app needed) ───────────
const VAPID_PUBLIC_KEY  = 'BFc_SttR5MObSucQbLl1sMbkNEEnV5JtqxBLmXpbd4tG0AajTQcUxUxRIiItVU4So2Mv7uvRgYB_p6xra0221lw';
const VAPID_PRIVATE_KEY = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgXsrGvGqcH13d9VQLKTboyOTHbdkVM4d9MrfQBEE0vGShRANCAARXP0rbUeTDm0rnEGy5dbDG5DRBJ1eSbasQS5l6W3eLRtAGo00HFMVMUSIiLVVOEqNjL-7r0YGAf6esa2tNttZc';

function b64uDec(s) {
  return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
}
function b64uEnc(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function makeVapidAuth(endpoint) {
  const origin = new URL(endpoint).origin;
  const exp = Math.floor(Date.now()/1000) + 43200;
  const hdr = b64uEnc(new TextEncoder().encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const pld = b64uEnc(new TextEncoder().encode(JSON.stringify({aud:origin,exp,sub:'mailto:admin@bait-almanama.bh'})));
  const input = hdr + '.' + pld;
  const pk = await crypto.subtle.importKey('pkcs8', b64uDec(VAPID_PRIVATE_KEY), {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, pk, new TextEncoder().encode(input));
  return 'vapid t=' + input + '.' + b64uEnc(sig) + ',k=' + VAPID_PUBLIC_KEY;
}

async function sendOnePush(sub) {
  try {
    const auth = await makeVapidAuth(sub.endpoint);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: auth, TTL: '60', Urgency: 'high' },
    });
    return r.status;
  } catch(e) { return null; }
}

async function notifyAllDevices(kv, title, body) {
  try {
    await kv.put('push-latest:data', JSON.stringify({ title, body }));
    const subs = JSON.parse(await kv.get('push-subs:all') || '[]');
    if (!subs.length) return;
    const results = await Promise.all(subs.map(async sub => ({ sub, status: await sendOnePush(sub) })));
    const valid = results.filter(r => r.status !== 410 && r.status !== 404).map(r => r.sub);
    if (valid.length < subs.length) await kv.put('push-subs:all', JSON.stringify(valid));
  } catch(e) {}
}
// ─────────────────────────────────────────────────────────────

// ── Bahrain date helper (UTC+3) ───────────────────────────────
function getBahrainDate() {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}
// ─────────────────────────────────────────────────────────────

function base64ToBuffer(base64) {
  const b64 = base64.includes(',') ? base64.split(',')[1] : base64;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function convertUnits(amount, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return amount;
  const toBase = { mg:0.001,g:1,kg:1000,ml:1,L:1000,cup:236.588,tbsp:14.787,tsp:4.929,pcs:1,portion:1,pack:1 };
  const wt = new Set(['mg','g','kg']);
  const vol = new Set(['ml','L','cup','tbsp','tsp']);
  const cnt = new Set(['pcs','portion','pack']);
  const fam = u => wt.has(u)?'w':vol.has(u)?'v':cnt.has(u)?'c':'';
  if (fam(fromUnit) !== fam(toUnit) || !fam(fromUnit)) return amount;
  if (!toBase[fromUnit] || !toBase[toUnit]) return amount;
  return amount * (toBase[fromUnit] / toBase[toUnit]);
}

const BASE_EMPLOYEES = [
  { name:'Mahdi',   password:'2000', isAdmin:true  },
  { name:'Hussein', password:'2424', isAdmin:false },
  { name:'Salman',  password:'2006', isAdmin:false },
  { name:'Ahmed',   password:'2009', isAdmin:false },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path_raw = url.pathname.replace('/api', '') || '/';

    const CORS = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    };

    const respond = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: CORS });

    // ── Serve static HTML for non-API routes ──────────────────
    if (!url.pathname.startsWith('/api')) {
      const resp = await env.ASSETS.fetch(request);
      if (url.pathname === '/sw.js') {
        const r = new Response(resp.body, resp);
        r.headers.set('Cache-Control', 'no-cache');
        r.headers.set('Service-Worker-Allowed', '/');
        return r;
      }
      return resp;
    }

    // ── CORS preflight ────────────────────────────────────────
    if (method === 'OPTIONS') return respond({}, 200);

    let body = {};
    if (['POST', 'PUT'].includes(method)) {
      try { body = await request.json(); } catch(e) {}
    }

    // ── KV helpers ────────────────────────────────────────────
    const kv = env.KV;
    const readKV = async (key, def) => {
      try { const v = await kv.get(key, { type:'json' }); return v !== null ? v : def; }
      catch(e) { return def; }
    };
    const writeKV = async (key, data) => {
      try { await kv.put(key, JSON.stringify(data)); } catch(e) {}
    };
    const bumpVersion = () => writeKV('menu-version:v', { t: Date.now() });
    const bumpDataVersion = () => writeKV('data-version:v', { t: Date.now() });

    try {

      // ── Menu version ────────────────────────────────────────
      if (method==='GET' && path_raw==='/menu-version')
        return respond(await readKV('menu-version:v', { t:0 }));

      // ── Data version (orders + stock + callouts) ─────────────
      if (method==='GET' && path_raw==='/data-version')
        return respond(await readKV('data-version:v', { t:0 }));

      // ── Latest sound event (for announcements) ────────────────
      if (method==='GET' && path_raw==='/latest-event')
        return respond(await readKV('latest-event:data', { event:null, ts:0 }));

      // ── Web Push endpoints ────────────────────────────────────
      if (method==='GET' && path_raw==='/vapid-public-key')
        return respond({ key: VAPID_PUBLIC_KEY });
      if (method==='GET' && path_raw==='/push-latest')
        return respond(await readKV('push-latest:data', { title:'Bait Al-Manama', body:'Tap to open' }));
      if (method==='POST' && path_raw==='/push-subscribe') {
        if (!body.endpoint) return respond({ error:'invalid' }, 400);
        const subs = JSON.parse(await kv.get('push-subs:all') || '[]');
        const others = subs.filter(s => s.endpoint !== body.endpoint);
        others.push(body);
        await kv.put('push-subs:all', JSON.stringify(others));
        return respond({ ok:true });
      }
      if (method==='POST' && path_raw==='/push-unsubscribe') {
        if (!body.endpoint) return respond({ error:'invalid' }, 400);
        const subs = JSON.parse(await kv.get('push-subs:all') || '[]');
        await kv.put('push-subs:all', JSON.stringify(subs.filter(s => s.endpoint !== body.endpoint)));
        return respond({ ok:true });
      }

      // ── Section status ──────────────────────────────────────
      if (method==='GET' && path_raw==='/section-status')
        return respond(await readKV('section-status:data', {}));
      if (method==='POST' && path_raw==='/section-status') {
        await writeKV('section-status:data', body); await bumpVersion();
        return respond({ ok:true });
      }

      // ── Custom Sections ─────────────────────────────────────
      if (method==='GET' && path_raw==='/custom-sections')
        return respond(await readKV('custom-sections:all', []));
      if (method==='POST' && path_raw==='/custom-sections') {
        if (!body.name) return respond({ error:'name required' }, 400);
        const sections = await readKV('custom-sections:all', []);
        const maxId = sections.reduce((m,s) => Math.max(m,s.id), 0);
        const ns = { id:maxId+1, name:body.name, label:body.name, cover_image:body.cover_image||'', created_at:new Date().toISOString() };
        sections.push(ns);
        await writeKV('custom-sections:all', sections); await bumpVersion();
        return respond({ id:ns.id, ok:true });
      }
      const cSecMatch = path_raw.match(/^\/custom-sections\/(\d+)$/);
      if (method==='PUT' && cSecMatch) {
        const sections = await readKV('custom-sections:all', []);
        const idx = sections.findIndex(s => s.id === parseInt(cSecMatch[1]));
        if (idx !== -1) {
          if (body.name !== undefined)        sections[idx].name = body.name;
          if (body.label !== undefined)       sections[idx].label = body.label;
          if (body.cover_image !== undefined) sections[idx].cover_image = body.cover_image;
        }
        await writeKV('custom-sections:all', sections); await bumpVersion();
        return respond({ ok:true });
      }
      if (method==='DELETE' && cSecMatch) {
        const sectionId = parseInt(cSecMatch[1]);
        const secKey = 'csec_' + sectionId;
        let sections = await readKV('custom-sections:all', []);
        sections = sections.filter(s => s.id !== sectionId);
        await writeKV('custom-sections:all', sections);
        let items = await readKV('custom-items:all', []);
        items = items.filter(i => i.section !== secKey);
        await writeKV('custom-items:all', items);
        const ss = await readKV('section-status:data', {});
        delete ss[secKey];
        await writeKV('section-status:data', ss); await bumpVersion();
        return respond({ ok:true });
      }

      // ── Media ───────────────────────────────────────────────
      const mediaMatch = path_raw.match(/^\/media\/(.+)$/);
      if (method==='GET' && mediaMatch) {
        const mkey = mediaMatch[1];
        const buf = await kv.get('media:f:' + mkey, { type:'arrayBuffer' });
        if (!buf) return new Response('Not found', { status:404 });
        const meta = await readKV('media:m:' + mkey, { mimeType:'application/octet-stream' });
        return new Response(buf, { headers: { 'Content-Type':meta.mimeType, 'Cache-Control':'public, max-age=86400', 'Access-Control-Allow-Origin':'*' } });
      }
      if (method==='POST' && path_raw==='/media/chunk') {
        const { uploadId, chunkIndex, totalChunks, data, mimeType } = body;
        if (!uploadId || chunkIndex === undefined || !data) return respond({ error:'missing fields' }, 400);
        await kv.put('media:chunk:' + uploadId + ':' + chunkIndex, base64ToBuffer(data));
        if (chunkIndex === 0) await writeKV('media:chunkmeta:' + uploadId, { mimeType:mimeType||'application/octet-stream', totalChunks:totalChunks||1 });
        return respond({ ok:true, chunk:chunkIndex });
      }
      if (method==='POST' && path_raw==='/media/finalize') {
        const { uploadId, key } = body;
        if (!uploadId || !key) return respond({ error:'uploadId and key required' }, 400);
        const meta = await readKV('media:chunkmeta:' + uploadId, null);
        if (!meta) return respond({ error:'Upload session not found' }, 404);
        const chunks = [];
        for (let i = 0; i < meta.totalChunks; i++) {
          const buf = await kv.get('media:chunk:' + uploadId + ':' + i, { type:'arrayBuffer' });
          if (!buf) return respond({ error:'Missing chunk ' + i }, 400);
          chunks.push(new Uint8Array(buf));
        }
        const totalLen = chunks.reduce((s,c) => s + c.length, 0);
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
        await kv.put('media:f:' + key, combined.buffer);
        await writeKV('media:m:' + key, { mimeType:meta.mimeType });
        for (let i = 0; i < meta.totalChunks; i++) await kv.delete('media:chunk:' + uploadId + ':' + i);
        await kv.delete('media:chunkmeta:' + uploadId);
        return respond({ ok:true, url:'/api/media/' + key });
      }
      if (method==='POST' && path_raw==='/media') {
        const { key, data, mimeType } = body;
        if (!key || !data) return respond({ error:'key and data required' }, 400);
        await kv.put('media:f:' + key, base64ToBuffer(data));
        await writeKV('media:m:' + key, { mimeType:mimeType||'application/octet-stream' });
        return respond({ ok:true, url:'/api/media/' + key });
      }

      // ── Orders ──────────────────────────────────────────────
      if (method==='GET' && path_raw==='/orders') {
        const status = url.searchParams.get('status');
        const orders = await readKV('orders:all', []);
        let filtered;
        if (status==='paid')        filtered = orders.filter(o => o.status==='paid').sort((a,b)=>new Date(b.paid_at)-new Date(a.paid_at));
        else if (status==='active') filtered = orders.filter(o => o.status==='active').sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        else if (status==='reservation') filtered = orders.filter(o => o.status==='reservation').sort((a,b)=>new Date(a.reservation_time||a.created_at)-new Date(b.reservation_time||b.created_at));
        else                        filtered = orders.filter(o => o.status==='active'||o.status==='reservation').sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        return respond(filtered);
      }
      if (method==='POST' && path_raw==='/orders') {
        const orders = await readKV('orders:all', []);
        const maxId = orders.reduce((m,o) => Math.max(m,o.id), 0);
        // ── Daily ticket counter (resets each day, Bahrain time) ──
        const dateKey = 'daily-ticket:' + getBahrainDate();
        const ticketData = await readKV(dateKey, { counter: 0 });
        ticketData.counter += 1;
        await writeKV(dateKey, ticketData);
        const ticketNo = ticketData.counter;
        const isReservation = !!(body.isReservation);
        const newOrder = { id:maxId+1, ticket_no:ticketNo, customer_name:body.customerName||'', phone_number:body.phoneNumber||'', table_number:body.tableNumber||'', items:JSON.stringify(body.items||[]), total:body.total||0, notes:body.notes||'', status: isReservation ? 'reservation' : 'active', reservation_time: body.reservationTime||null, reservation_note: body.reservationNote||'', payment_method:null, completed_at:null, paid_at:null, created_at:new Date().toISOString() };
        orders.push(newOrder);
        await writeKV('orders:all', orders);
        // ── Deduct plate stock on placement (skip for reservations) ──
        if (!isReservation) {
        try {
          const placedItems = body.items || [];
          const stock = await readKV('item-stock:all', {});
          const disabled = await readKV('disabled-items:data', {});
          let stockChanged = false, disabledChanged = false;
          for (const oi of placedItems) {
            if (stock[oi.name] !== undefined && stock[oi.name] !== null) {
              stock[oi.name] = Math.max(0, stock[oi.name] - oi.qty); stockChanged = true;
              if (stock[oi.name] <= 0) { disabled[oi.name]=true; disabledChanged=true; }
            }
          }
          if (stockChanged) await writeKV('item-stock:all', stock);
          if (disabledChanged) { await writeKV('disabled-items:data', disabled); await bumpVersion(); }
        } catch(e) {}
        // ── Deduct inventory on placement ─────────────────────
        try {
          const placedItems2 = body.items || [];
          const assignments = await readKV('item-inv:data', {});
          const invItems = await readKV('inventory:all', []);
          const disabled2 = await readKV('disabled-items:data', {});
          let invChanged = false, disabledChanged2 = false;
          for (const oi of placedItems2) {
            const assign = assignments[oi.name]; if (!assign) continue;
            const iIdx = invItems.findIndex(i => i.id === assign.inventoryId); if (iIdx === -1) continue;
            const deductAmt = convertUnits(assign.usagePerServing * oi.qty, assign.servingUnit||invItems[iIdx].unit, invItems[iIdx].unit);
            invItems[iIdx].quantity = Math.max(0, invItems[iIdx].quantity - deductAmt); invChanged = true;
            if (invItems[iIdx].quantity <= 0) { for (const mn in assignments) { if (assignments[mn].inventoryId === assign.inventoryId) { disabled2[mn]=true; disabled2['__inv_'+mn]=true; disabledChanged2=true; } } }
          }
          if (invChanged) await writeKV('inventory:all', invItems);
          if (disabledChanged2) { await writeKV('disabled-items:data', disabled2); await bumpVersion(); }
        } catch(e) {}
        // Web Push notification
        const tableLabel = body.tableNumber ? 'Table ' + body.tableNumber : 'No table';
        const itemSummary = (body.items||[]).map(i => i.name + ' x' + i.qty).join(', ');
        const totalStr = Number(body.total||0).toFixed(3) + ' BD';
        ctx.waitUntil(bumpDataVersion().catch(() => {}));
        ctx.waitUntil(notifyAllDevices(kv,
          'New Order — ' + tableLabel,
          itemSummary + ' | ' + totalStr + (body.notes ? ' | ' + body.notes : '')
        ).catch(() => {}));
        } else {
          // Reservation: just notify + bump version, no stock deduction
          ctx.waitUntil(bumpDataVersion().catch(()=>{}));
        }
        return respond({ id:newOrder.id });
      }
      const doneMatch = path_raw.match(/^\/orders\/(\d+)\/done$/);
      if (method==='POST' && doneMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(doneMatch[1]));
        if (idx !== -1) orders[idx].completed_at = new Date().toISOString();
        await writeKV('orders:all', orders);
        if (idx !== -1) {
          const o = orders[idx];
          await writeKV('latest-event:data', { event:'done', ticketNo: o.ticket_no||o.id, tableNo: o.table_number||'?', ts: Date.now() });
        }
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }
      const paidMatch = path_raw.match(/^\/orders\/(\d+)\/paid$/);
      if (method==='POST' && paidMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(paidMatch[1]));
        if (idx !== -1) { orders[idx].status='paid'; orders[idx].payment_method=body.paymentMethod||'Cash'; orders[idx].paid_at=new Date().toISOString(); }
        await writeKV('orders:all', orders);
        if (idx !== -1) {
          const o = orders[idx];
          const pmRaw = body.paymentMethod || 'Cash';
          let methodLabel = pmRaw;
          if (pmRaw.startsWith('[')) {
            try { methodLabel = JSON.parse(pmRaw).map(s=>s.method).join(' + '); } catch(e) {}
          }
          await writeKV('latest-event:data', { event:'paid', ticketNo: o.ticket_no||o.id, tableNo: o.table_number||'?', total: o.total, method: methodLabel, ts: Date.now() });
        }
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }
      const repayMatch = path_raw.match(/^\/orders\/(\d+)\/repay$/);
      if (method==='POST' && repayMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(repayMatch[1]));
        if (idx !== -1) orders[idx].payment_method = body.paymentMethod || 'Cash';
        await writeKV('orders:all', orders);
        return respond({ ok:true });
      }
      const editMatch = path_raw.match(/^\/orders\/(\d+)\/edit$/);
      if (method==='POST' && editMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(editMatch[1]));
        if (idx !== -1) {
          orders[idx].items = JSON.stringify(body.items||[]);
          orders[idx].total = body.total||0;
          // If it was already marked done, reopen it — kitchen needs to re-confirm
          if (orders[idx].completed_at) orders[idx].completed_at = null;
        }
        await writeKV('orders:all', orders);
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }
      const staffNoteMatch = path_raw.match(/^\/orders\/(\d+)\/staff-note$/);
      if (method==='POST' && staffNoteMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(staffNoteMatch[1]));
        if (idx !== -1) orders[idx].staff_note = body.note || '';
        await writeKV('orders:all', orders);
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }
      // ── Site background image ─────────────────────────────────
      if (method==='GET' && path_raw==='/site-bg')
        return respond(await readKV('site-bg:data', { url: '' }));
      if (method==='POST' && path_raw==='/site-bg') {
        await writeKV('site-bg:data', { url: body.url || '' });
        return respond({ ok:true });
      }
      // ── Reset tickets (testing only) ─────────────────────────
      if (method==='POST' && path_raw==='/reset-tickets') {
        let orders = await readKV('orders:all', []);
        orders = orders.filter(o => o.status !== 'paid');
        await writeKV('orders:all', orders);
        const dateKey = 'daily-ticket:' + getBahrainDate();
        await writeKV(dateKey, { counter: 0 });
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok: true });
      }
      // ── Custom item display names (Arabic + English) ──────────
      if (method==='GET' && path_raw==='/item-display-names')
        return respond(await readKV('item-display-names:all', {}));
      if (method==='POST' && path_raw==='/item-display-names') {
        await writeKV('item-display-names:all', body);
        return respond({ ok:true });
      }
      // ── WhatsApp auto-report settings ────────────────────────
      if (method==='GET' && path_raw==='/report-settings')
        return respond(await readKV('report-settings:v', {}));
      if (method==='POST' && path_raw==='/report-settings') {
        await writeKV('report-settings:v', body);
        return respond({ ok:true });
      }
      // ── Activate a reservation → moves to active + deducts stock
      const activateMatch = path_raw.match(/^\/orders\/(\d+)\/activate$/);
      if (method==='POST' && activateMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(activateMatch[1]));
        if (idx !== -1) {
          orders[idx].status = 'active';
          orders[idx].activated_at = new Date().toISOString();
          // deduct stock now that kitchen will actually make it
          try {
            const placedItems = JSON.parse(orders[idx].items || '[]');
            const stock = await readKV('item-stock:all', {});
            const disabled = await readKV('disabled-items:data', {});
            let sc=false,dc=false;
            for (const oi of placedItems) {
              if (stock[oi.name]!==undefined&&stock[oi.name]!==null) {
                stock[oi.name]=Math.max(0,stock[oi.name]-oi.qty); sc=true;
                if(stock[oi.name]<=0){disabled[oi.name]=true;dc=true;}
              }
            }
            if(sc) await writeKV('item-stock:all', stock);
            if(dc){await writeKV('disabled-items:data',disabled);await bumpVersion();}
          } catch(e){}
        }
        await writeKV('orders:all', orders);
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }
      const deleteMatch = path_raw.match(/^\/orders\/(\d+)$/);
      if (method==='DELETE' && deleteMatch) {
        let orders = await readKV('orders:all', []);
        const orderToDelete = orders.find(o => o.id === parseInt(deleteMatch[1]));
        orders = orders.filter(o => o.id !== parseInt(deleteMatch[1]));
        await writeKV('orders:all', orders);
        // ── Restore plate stock if order was active (not paid) ──
        if (orderToDelete && orderToDelete.status === 'active') {
          try {
            const restoredItems = JSON.parse(orderToDelete.items || '[]');
            const stock = await readKV('item-stock:all', {});
            const disabled = await readKV('disabled-items:data', {});
            let stockChanged = false, disabledChanged = false;
            for (const oi of restoredItems) {
              if (stock[oi.name] !== undefined && stock[oi.name] !== null) {
                const wasZero = stock[oi.name] <= 0;
                stock[oi.name] += oi.qty; stockChanged = true;
                if (wasZero && stock[oi.name] > 0) { delete disabled[oi.name]; disabledChanged = true; }
              }
            }
            if (stockChanged) await writeKV('item-stock:all', stock);
            if (disabledChanged) { await writeKV('disabled-items:data', disabled); await bumpVersion(); }
          } catch(e) {}
          // ── Restore inventory if order was active ─────────────
          try {
            const restoredItems2 = JSON.parse(orderToDelete.items || '[]');
            const assignments = await readKV('item-inv:data', {});
            const invItems = await readKV('inventory:all', []);
            const disabled2 = await readKV('disabled-items:data', {});
            let invChanged = false, disabledChanged2 = false;
            for (const oi of restoredItems2) {
              const assign = assignments[oi.name]; if (!assign) continue;
              const iIdx = invItems.findIndex(i => i.id === assign.inventoryId); if (iIdx === -1) continue;
              const restoreAmt = convertUnits(assign.usagePerServing * oi.qty, assign.servingUnit||invItems[iIdx].unit, invItems[iIdx].unit);
              invItems[iIdx].quantity += restoreAmt; invChanged = true;
              if (invItems[iIdx].quantity > 0) {
                for (const mn in assignments) {
                  if (assignments[mn].inventoryId === assign.inventoryId && disabled2['__inv_'+mn]) {
                    delete disabled2[mn]; delete disabled2['__inv_'+mn]; disabledChanged2 = true;
                  }
                }
              }
            }
            if (invChanged) await writeKV('inventory:all', invItems);
            if (disabledChanged2) { await writeKV('disabled-items:data', disabled2); await bumpVersion(); }
          } catch(e) {}
        }
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }
      if (method==='POST' && path_raw==='/orders/clear-paid') {
        let orders = await readKV('orders:all', []);
        const before = orders.length;
        orders = orders.filter(o => o.status !== 'paid');
        await writeKV('orders:all', orders);
        return respond({ deleted: before - orders.length });
      }

      // ── Callouts ────────────────────────────────────────────
      if (method==='GET' && path_raw==='/callouts') {
        const callouts = await readKV('callouts:all', []);
        return respond(callouts.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)));
      }
      if (method==='POST' && path_raw==='/callouts') {
        const callouts = await readKV('callouts:all', []);
        const maxId = callouts.reduce((m,c) => Math.max(m,c.id), 0);
        const nc = { id:maxId+1, table_number:body.tableNumber||'?', created_at:new Date().toISOString() };
        callouts.push(nc); await writeKV('callouts:all', callouts);
        ctx.waitUntil(bumpDataVersion().catch(() => {}));
        ctx.waitUntil(notifyAllDevices(kv,
          'Table ' + (body.tableNumber||'?') + ' is calling!',
          'A customer needs assistance at table ' + (body.tableNumber||'?')
        ).catch(() => {}));
        return respond({ id:nc.id });
      }
      const calloutDeleteMatch = path_raw.match(/^\/callouts\/(\d+)$/);
      if (method==='DELETE' && calloutDeleteMatch) {
        let callouts = await readKV('callouts:all', []);
        callouts = callouts.filter(c => c.id !== parseInt(calloutDeleteMatch[1]));
        await writeKV('callouts:all', callouts);
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }

      // ── Disabled items ───────────────────────────────────────
      if (method==='GET' && path_raw==='/disabled-items')
        return respond(await readKV('disabled-items:data', {}));
      if (method==='POST' && path_raw==='/disabled-items') {
        await writeKV('disabled-items:data', body); await bumpVersion();
        return respond({ ok:true });
      }

      // ── Custom items ─────────────────────────────────────────
      if (method==='GET' && path_raw==='/custom-items')
        return respond(await readKV('custom-items:all', []));
      if (method==='POST' && path_raw==='/custom-items') {
        if (!body.name || body.price === undefined || !body.section) return respond({ error:'name, price, section required' }, 400);
        const items = await readKV('custom-items:all', []);
        const maxId = items.reduce((m,i) => Math.max(m,i.id), 0);
        const ni = { id:maxId+1, name:body.name, price:body.price, image_url:body.image_url||'', is_video:body.is_video||false, section:body.section, created_at:new Date().toISOString() };
        items.push(ni); await writeKV('custom-items:all', items); await bumpVersion();
        return respond({ id:ni.id, ok:true });
      }
      const customEditMatch = path_raw.match(/^\/custom-items\/(\d+)$/);
      if (method==='PUT' && customEditMatch) {
        const items = await readKV('custom-items:all', []);
        const idx = items.findIndex(i => i.id === parseInt(customEditMatch[1]));
        if (idx !== -1) { items[idx].name=body.name; items[idx].price=body.price; items[idx].image_url=body.image_url||''; items[idx].is_video=body.is_video||false; }
        await writeKV('custom-items:all', items); await bumpVersion();
        return respond({ ok:true });
      }
      if (method==='DELETE' && customEditMatch) {
        let items = await readKV('custom-items:all', []);
        items = items.filter(i => i.id !== parseInt(customEditMatch[1]));
        await writeKV('custom-items:all', items); await bumpVersion();
        return respond({ ok:true });
      }

      // ── Menu overrides ───────────────────────────────────────
      if (method==='GET' && path_raw==='/menu-overrides')
        return respond(await readKV('menu-overrides:data', {}));
      if (method==='POST' && path_raw==='/menu-overrides') {
        await writeKV('menu-overrides:data', body); await bumpVersion();
        return respond({ ok:true });
      }

      // ── Auth ─────────────────────────────────────────────────
      if (method==='POST' && path_raw==='/auth/login') {
        const settings = await readKV('settings:data', { password:'1960' });
        if (body.password === (settings.password || '1960')) return respond({ ok:true });
        return respond({ ok:false, error:'Wrong Credentials' }, 401);
      }
      if (method==='POST' && path_raw==='/auth/change-password') {
        const settings = await readKV('settings:data', { password:'1960' });
        if (body.oldPassword !== (settings.password || '1960')) return respond({ ok:false, error:'Wrong Credentials' }, 401);
        if (!body.newPassword) return respond({ ok:false, error:'New password required' }, 400);
        settings.password = body.newPassword;
        await writeKV('settings:data', settings);
        return respond({ ok:true });
      }

      // ── Inventory ────────────────────────────────────────────
      if (method==='GET' && path_raw==='/inventory')
        return respond(await readKV('inventory:all', []));
      if (method==='POST' && path_raw==='/inventory') {
        const { name, quantity, unit } = body;
        if (!name || quantity === undefined || !unit) return respond({ error:'name, quantity, unit required' }, 400);
        const items = await readKV('inventory:all', []);
        const maxId = items.reduce((m,i) => Math.max(m,i.id), 0);
        items.push({ id:maxId+1, name, quantity:Number(quantity), unit, created_at:new Date().toISOString() });
        await writeKV('inventory:all', items);
        return respond({ id:maxId+1, ok:true });
      }
      const invMatch = path_raw.match(/^\/inventory\/(\d+)$/);
      if (method==='PUT' && invMatch) {
        const items = await readKV('inventory:all', []);
        const idx = items.findIndex(i => i.id === parseInt(invMatch[1]));
        if (idx !== -1) {
          if (body.name !== undefined)     items[idx].name = body.name;
          if (body.quantity !== undefined) items[idx].quantity = Number(body.quantity);
          if (body.unit !== undefined)     items[idx].unit = body.unit;
          if (items[idx].quantity > 0) {
            const assignments = await readKV('item-inv:data', {});
            const disabled = await readKV('disabled-items:data', {});
            let changed = false;
            for (const mn in assignments) {
              if (assignments[mn].inventoryId === parseInt(invMatch[1]) && disabled['__inv_'+mn]) {
                delete disabled[mn]; delete disabled['__inv_'+mn]; changed = true;
              }
            }
            if (changed) { await writeKV('disabled-items:data', disabled); await bumpVersion(); }
          }
        }
        await writeKV('inventory:all', items);
        return respond({ ok:true });
      }
      if (method==='DELETE' && invMatch) {
        let items = await readKV('inventory:all', []);
        items = items.filter(i => i.id !== parseInt(invMatch[1]));
        await writeKV('inventory:all', items);
        return respond({ ok:true });
      }

      // ── Item-Inventory assignments ───────────────────────────
      if (method==='GET' && path_raw==='/item-inventory')
        return respond(await readKV('item-inv:data', {}));
      if (method==='POST' && path_raw==='/item-inventory') {
        await writeKV('item-inv:data', body);
        return respond({ ok:true });
      }

      // ── Item plate stock ─────────────────────────────────────
      if (method==='GET' && path_raw==='/item-stock')
        return respond(await readKV('item-stock:all', {}));
      if (method==='POST' && path_raw==='/item-stock') {
        const stock = await readKV('item-stock:all', {});
        Object.assign(stock, body);
        for (const k in stock) { if (stock[k] === null) delete stock[k]; }
        await writeKV('item-stock:all', stock);
        ctx.waitUntil(bumpDataVersion());
        return respond({ ok:true });
      }

      // ── Employees ────────────────────────────────────────────
      if (method==='GET' && path_raw==='/employees') {
        let emps = await readKV('employees:all', BASE_EMPLOYEES);
        BASE_EMPLOYEES.forEach(b => { if (!emps.find(e => e.name === b.name)) emps.push(b); });
        return respond(emps);
      }
      if (method==='POST' && path_raw==='/employees') {
        if (!Array.isArray(body)) return respond({ error:'Expected array' }, 400);
        await writeKV('employees:all', body);
        return respond({ ok:true });
      }

      return respond({ error:'Not found' }, 404);

    } catch(err) {
      return respond({ error: err.message }, 500);
    }
  },

  // ── Cron: Midnight Bahrain → Send WhatsApp end-of-day report ─
  async scheduled(event, env, ctx) {
    try {
      const kv = env.KV;
      const settings = JSON.parse(await kv.get('report-settings:v') || '{}');
      if (!settings.waPhone || !settings.waApiKey) return;
      // Yesterday in Bahrain time
      const yesterday = new Date(Date.now() + 3*60*60*1000 - 86400000);
      const dateStr = yesterday.toISOString().split('T')[0];
      const orders = JSON.parse(await kv.get('orders:all') || '[]');
      const dayOrders = orders.filter(o => o.status==='paid' && (o.paid_at||'').startsWith(dateStr));
      const total = dayOrders.reduce((s,o) => s+Number(o.total||0), 0);
      const methods = {};
      dayOrders.forEach(o => {
        const pm = o.payment_method||'Cash';
        if (pm.startsWith('[')) { try { JSON.parse(pm).forEach(s=>{methods[s.method]=(methods[s.method]||0)+Number(s.amount);}); }catch(e){} }
        else { methods[pm]=(methods[pm]||0)+Number(o.total||0); }
      });
      const itemCounts = {};
      dayOrders.forEach(o => {
        try { (JSON.parse(o.items||'[]')).forEach(i => { itemCounts[i.name]=(itemCounts[i.name]||0)+i.qty; }); }catch(e){}
      });
      const topItems = Object.entries(itemCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>'• '+e[0]+': x'+e[1]).join('\n');
      const lines = [
        '📊 *بيت المنامة — التقرير اليومي*',
        '📅 '+dateStr,
        '',
        '💰 الإيراد: '+total.toFixed(3)+' BD',
        '🎫 الطلبات: '+dayOrders.length,
        '',
        '💳 كاش: '+(methods['Cash']||0).toFixed(3)+' BD',
        '💳 بطاقة: '+(methods['Card']||0).toFixed(3)+' BD',
        '💳 بنفت: '+(methods['Benefit']||0).toFixed(3)+' BD',
        '',
        '🏆 أكثر المبيعات:',
        topItems || '• لا بيانات'
      ];
      const msg = encodeURIComponent(lines.join('\n'));
      await fetch(`https://api.callmebot.com/whatsapp.php?phone=${settings.waPhone}&text=${msg}&apikey=${settings.waApiKey}`);
    } catch(e) {}
  }
};
