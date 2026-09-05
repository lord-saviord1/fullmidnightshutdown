// This file goes in /api/paystack-webhook.js at the root of your project (a sibling folder
// to index.html) — Vercel automatically turns anything in /api into a serverless function.
//
// SETUP (one-time):
// 1. In Vercel project settings → Environment Variables, add:
//      PAYSTACK_SECRET_KEY   — Paystack dashboard → Settings → API Keys & Webhooks
//      SUPABASE_URL          — same value as in index.html/admin.html
//      SUPABASE_SERVICE_KEY  — Supabase → Project Settings → API → "service_role" key.
//                              Bypasses row-level security — never put this in a client file,
//                              only here as a server-side environment variable.
//      RESEND_API_KEY        — from resend.com (free tier). Used to send confirmation emails.
//      RESEND_FROM           — the sender address, e.g. "FMS <tickets@yourdomain.com>".
//                              Until you verify your own domain in Resend, you can use their
//                              sandbox sender: "FMS <onboarding@resend.dev>" for testing.
// 2. In Supabase SQL editor, also run (in addition to the "tickets" table from before):
//      create table ticket_sales (
//        id uuid primary key default gen_random_uuid(),
//        ticket_type text not null,
//        buyer_name text not null,
//        buyer_email text not null,
//        unique_code text not null unique,
//        created_at timestamptz not null default now(),
//        checked_in boolean not null default false
//      );
//      alter table ticket_sales enable row level security;
//      create policy "authenticated read" on ticket_sales for select using (auth.role() = 'authenticated');
//      create policy "authenticated update" on ticket_sales for update using (auth.role() = 'authenticated');
//      -- no policy for anon/public — only the service role (this function) and a logged-in
//      -- admin (via admin.html) can ever read or write sale records.
// 3. In Paystack dashboard → Settings → API Keys & Webhooks, set the webhook URL to:
//      https://your-domain.vercel.app/api/paystack-webhook
// 4. Deploy. Every successful payment now: records the sale, generates a gate code, emails it.

const crypto = require('crypto');

function generateCode(){
  // Short, readable, hard to guess by brute force at the door — e.g. FMS-7K2P9Q
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid gate confusion
  let code = 'FMS-';
  for(let i = 0; i < 6; i++){ code += chars[crypto.randomInt(chars.length)]; }
  return code;
}

function emailHtml({ name, ticketType, code }){
  return `
  <div style="background:#efe7d3;padding:32px 16px;font-family:Georgia,serif;color:#1a1512;">
    <div style="max-width:420px;margin:0 auto;background:#f5efdf;border:3px solid #1a1512;padding:32px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="color:#c0271a;font-size:20px;">★</span>
        <strong style="font-size:20px;letter-spacing:1px;">FMS — FULL MIDNIGHT SHUTDOWN</strong>
        <div style="font-size:11px;letter-spacing:2px;color:#7c2fb0;margin-top:4px;">FRESHERS MEET STAYLITE EDITION · LASU</div>
      </div>
      <p style="font-size:15px;line-height:1.6;">Hi ${name},</p>
      <p style="font-size:15px;line-height:1.6;">You're confirmed for <strong>${ticketType}</strong>. Show this code at the gate on the night — Saturday 14th November, doors 10PM.</p>
      <div style="text-align:center;margin:28px 0;padding:20px;background:#1a1512;">
        <div style="color:#a89b81;font-size:11px;letter-spacing:2px;margin-bottom:8px;">YOUR GATE CODE</div>
        <div style="color:#ff3fa8;font-size:32px;font-weight:bold;letter-spacing:3px;">${code}</div>
      </div>
      <p style="font-size:13px;line-height:1.6;color:#463b30;">Keep this email — the code is checked against our list at entry. No re-entry once you leave the venue.</p>
      <p style="font-size:13px;color:#463b30;margin-top:24px;">— Cipher PR</p>
    </div>
  </div>`;
}

// Disables Vercel's automatic JSON body parsing for this function. Paystack signs the webhook
// using the exact raw bytes of what it sent — if we let Vercel parse the body into an object
// and then re-serialize it to check the signature, the re-serialized version doesn't always
// match byte-for-byte, and the signature check silently fails every time. Reading the raw
// bytes ourselves (below) is the only reliable way to verify it.

function getRawBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const rawBody = await getRawBody(req);
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers['x-paystack-signature'];
  const expectedSignature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

  if (signature !== expectedSignature) {
    res.status(401).send('Invalid signature');
    return;
  }

  const event = JSON.parse(rawBody);
  if (event.event !== 'charge.success') {
    res.status(200).send('Ignored (not a successful charge)');
    return;
  }

  const data = event.data;
  const customFields = data?.metadata?.custom_fields || [];
  const getField = (name) => customFields.find(f => f.variable_name === name)?.value || '';

  const ticketName = getField('ticket_type');
  const buyerName = getField('full_name') || data?.customer?.first_name || 'Guest';
  const buyerEmail = data?.customer?.email || '';

  const ticketId = ticketName === 'Freshers Squad Rate' ? 'freshers'
                  : ticketName === 'Standard' ? 'standard'
                  : null;

  if (!ticketId || !buyerEmail) {
    res.status(200).send('Missing ticket type or email — nothing recorded');
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const sbHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  const code = generateCode();

  // 1. Record the individual sale (name, email, code, timestamp) for gate checking
  await fetch(`${supabaseUrl}/rest/v1/ticket_sales`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      ticket_type: ticketName,
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      unique_code: code
    })
  });

  // 2. Bump the aggregate sold count (drives the sold-out UI on the site)
  const getRes = await fetch(`${supabaseUrl}/rest/v1/tickets?id=eq.${ticketId}&select=sold`, { headers: sbHeaders });
  const rows = await getRes.json();
  const currentSold = rows[0]?.sold ?? 0;
  await fetch(`${supabaseUrl}/rest/v1/tickets?id=eq.${ticketId}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ sold: currentSold + 1 })
  });

  // 3. Email the buyer their confirmation + gate code
  const resendKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM;
  if (resendKey && fromAddress) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddress,
        to: [buyerEmail],
        subject: 'Your FMS ticket — Full Midnight Shutdown',
        html: emailHtml({ name: buyerName, ticketType: ticketName, code })
      })
    });
  }

  res.status(200).send('Sale recorded and confirmation sent');
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
