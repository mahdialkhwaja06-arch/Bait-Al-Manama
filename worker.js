/**
 * Bait Al-Manama — Cloudflare Worker
 * Serves static HTML files via ASSETS binding
 * Handles all /api/* routes via KV storage
 */

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
      return env.ASSETS.fetch(request);
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

    try {

      // ── Menu version ────────────────────────────────────────
      if (method==='GET' && path_raw==='/menu-version')
        return respond(await readKV('menu-version:v', { t:0 }));

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
        const filtered = status==='paid'
          ? orders.filter(o => o.status==='paid').sort((a,b) => new Date(b.paid_at) - new Date(a.paid_at))
          : orders.filter(o => o.status==='active').sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
        return respond(filtered);
      }
      if (method==='POST' && path_raw==='/orders') {
        const orders = await readKV('orders:all', []);
        const maxId = orders.reduce((m,o) => Math.max(m,o.id), 0);
        const newOrder = { id:maxId+1, customer_name:body.customerName||'', phone_number:body.phoneNumber||'', table_number:body.tableNumber||'', items:JSON.stringify(body.items||[]), total:body.total||0, notes:body.notes||'', status:'active', payment_method:null, completed_at:null, paid_at:null, created_at:new Date().toISOString() };
        orders.push(newOrder);
        await writeKV('orders:all', orders);
        return respond({ id:newOrder.id });
      }
      const doneMatch = path_raw.match(/^\/orders\/(\d+)\/done$/);
      if (method==='POST' && doneMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(doneMatch[1]));
        if (idx !== -1) orders[idx].completed_at = new Date().toISOString();
        await writeKV('orders:all', orders);
        return respond({ ok:true });
      }
      const paidMatch = path_raw.match(/^\/orders\/(\d+)\/paid$/);
      if (method==='POST' && paidMatch) {
        const orders = await readKV('orders:all', []);
        const idx = orders.findIndex(o => o.id === parseInt(paidMatch[1]));
        if (idx !== -1) { orders[idx].status='paid'; orders[idx].payment_method=body.paymentMethod||'Cash'; orders[idx].paid_at=new Date().toISOString(); }
        await writeKV('orders:all', orders);
        if (idx !== -1) {
          try {
            const orderItems = JSON.parse(orders[idx].items || '[]');
            const assignments = await readKV('item-inv:data', {});
            const invItems = await readKV('inventory:all', []);
            const disabled = await readKV('disabled-items:data', {});
            let invChanged = false, disabledChanged = false;
            for (const oi of orderItems) {
              const assign = assignments[oi.name]; if (!assign) continue;
              const iIdx = invItems.findIndex(i => i.id === assign.inventoryId); if (iIdx === -1) continue;
              const deductAmt = convertUnits(assign.usagePerServing * oi.qty, assign.servingUnit||invItems[iIdx].unit, invItems[iIdx].unit);
              invItems[iIdx].quantity = Math.max(0, invItems[iIdx].quantity - deductAmt); invChanged = true;
              if (invItems[iIdx].quantity <= 0) { for (const mn in assignments) { if (assignments[mn].inventoryId === assign.inventoryId) { disabled[mn]=true; disabled['__inv_'+mn]=true; disabledChanged=true; } } }
            }
            if (invChanged) await writeKV('inventory:all', invItems);
            if (disabledChanged) { await writeKV('disabled-items:data', disabled); await bumpVersion(); }
          } catch(e) {}
          try {
            const orderItems2 = JSON.parse(orders[idx].items || '[]');
            const stock = await readKV('item-stock:all', {});
            const disabled2 = await readKV('disabled-items:data', {});
            let stockChanged = false, disabledChanged2 = false;
            for (const oi of orderItems2) {
              if (stock[oi.name] !== undefined && stock[oi.name] !== null) {
                stock[oi.name] = Math.max(0, stock[oi.name] - oi.qty); stockChanged = true;
                if (stock[oi.name] <= 0) { disabled2[oi.name]=true; disabledChanged2=true; }
              }
            }
            if (stockChanged) await writeKV('item-stock:all', stock);
            if (disabledChanged2) { await writeKV('disabled-items:data', disabled2); await bumpVersion(); }
          } catch(e) {}
        }
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
        if (idx !== -1) { orders[idx].items=JSON.stringify(body.items||[]); orders[idx].total=body.total||0; }
        await writeKV('orders:all', orders);
        return respond({ ok:true });
      }
      const deleteMatch = path_raw.match(/^\/orders\/(\d+)$/);
      if (method==='DELETE' && deleteMatch) {
        let orders = await readKV('orders:all', []);
        orders = orders.filter(o => o.id !== parseInt(deleteMatch[1]));
        await writeKV('orders:all', orders);
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
        return respond({ id:nc.id });
      }
      const calloutDeleteMatch = path_raw.match(/^\/callouts\/(\d+)$/);
      if (method==='DELETE' && calloutDeleteMatch) {
        let callouts = await readKV('callouts:all', []);
        callouts = callouts.filter(c => c.id !== parseInt(calloutDeleteMatch[1]));
        await writeKV('callouts:all', callouts);
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
  }
};
