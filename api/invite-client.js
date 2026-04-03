import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SITE_URL = process.env.SITE_URL || 'https://northline-capital.com';
const RESEND_KEY = process.env.RESEND_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, first, last, phone, goal, balance, credit } = req.body;
  if (!email || !first || !last) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. Create or get Supabase user
    let userId = null;
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email === email);

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: { first_name: first, last_name: last }
      });
      if (createError) console.error('Create user error:', createError);
      else userId = newUser?.user?.id;
    }

    // 2. Generate magic link
    let magicLink = SITE_URL;
    if (userId) {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo: SITE_URL }
      });
      if (!linkError && linkData?.properties?.action_link) {
        magicLink = linkData.properties.action_link;
      }
    }

    // 3. Upsert lead record
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .upsert({
        email,
        first_name: first,
        last_name: last,
        phone: phone || null,
        goal: goal || null,
        loan_balance: balance ? parseFloat(String(balance).replace(/[$,]/g, '')) : null,
        credit_score: credit || null,
        user_id: userId || null,
        status: 'new',
        source: 'website'
      }, { onConflict: 'email' })
      .select()
      .single();

    if (leadError) console.error('Lead error:', leadError);

    // 4. Create pipeline + docs
    if (lead) {
      const { error: pipeError } = await supabase
        .from('loan_pipeline')
        .upsert({
          lead_id: lead.id,
          user_id: userId || null,
          stage: 'application',
          loan_amount: balance ? parseFloat(String(balance).replace(/[$,]/g, '')) : null,
          application_date: new Date().toISOString().split('T')[0]
        }, { onConflict: 'lead_id' });
      if (pipeError) console.error('Pipeline error:', pipeError);

      const { data: existingDocs } = await supabase
        .from('documents').select('id').eq('lead_id', lead.id).limit(1);

      if (!existingDocs || existingDocs.length === 0) {
        await supabase.from('documents').insert([
          { lead_id: lead.id, doc_type: 'w2',                 file_name: '2024 W-2 / Tax Returns',            file_type: 'pending', storage_path: 'pending', status: 'pending_upload' },
          { lead_id: lead.id, doc_type: 'pay_stub',           file_name: 'Last 2 Pay Stubs',                  file_type: 'pending', storage_path: 'pending', status: 'pending_upload' },
          { lead_id: lead.id, doc_type: 'bank_statement',     file_name: 'Bank Statements (2 months)',         file_type: 'pending', storage_path: 'pending', status: 'pending_upload' },
          { lead_id: lead.id, doc_type: 'insurance',          file_name: "Homeowner's Insurance Declaration", file_type: 'pending', storage_path: 'pending', status: 'pending_upload' },
          { lead_id: lead.id, doc_type: 'mortgage_statement', file_name: 'Current Mortgage Statement',        file_type: 'pending', storage_path: 'pending', status: 'pending_upload' },
          { lead_id: lead.id, doc_type: 'id',                 file_name: "Photo ID (Driver's License)",       file_type: 'pending', storage_path: 'pending', status: 'pending_upload' }
        ]);
      }
    }

    // 5. Send email via Resend directly (bypasses Supabase email limits)
    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#1a1a2e;">
        <div style="text-align:center;margin-bottom:32px;">
          <div style="display:inline-block;background:linear-gradient(135deg,#c9963c,#e8b96a);width:48px;height:48px;border-radius:12px;line-height:48px;font-size:22px;font-weight:800;color:#0b1f3a;text-align:center;">N</div>
          <div style="font-size:20px;font-weight:700;color:#0b1f3a;margin-top:8px;">Northline Capital</div>
        </div>
        <h2 style="font-size:24px;font-weight:800;color:#0b1f3a;margin-bottom:12px;">Hi ${first}, your loan portal is ready.</h2>
        <p style="font-size:15px;color:#6b7280;line-height:1.6;margin-bottom:28px;">
          Thank you for your refinance inquiry. Your secure loan dashboard has been created.
          Click below to access your application status, document checklist, and loan details.
        </p>
        <div style="text-align:center;margin-bottom:32px;">
          <a href="${magicLink}" style="display:inline-block;background:#0b1f3a;color:#ffffff;font-weight:700;font-size:15px;padding:16px 40px;border-radius:10px;text-decoration:none;">
            Access My Loan Portal →
          </a>
        </div>
        <p style="font-size:13px;color:#9ca3af;text-align:center;margin-bottom:8px;">
          This link expires in 24 hours. If you did not request this, you can ignore this email.
        </p>
        <hr style="border:none;border-top:1px solid #e8e2d8;margin:24px 0;">
        <p style="font-size:12px;color:#9ca3af;text-align:center;">
          Northline Capital · NMLS #XXXXXX · CA DRE #XXXXXXX<br>
          Questions? Call us at (949) 555-0000
        </p>
      </div>
    `;

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Northline Capital <onboarding@resend.dev>',
        to: [email],
        subject: 'Your Northline Capital loan portal is ready',
        html: emailHtml
      })
    });

    const resendResult = await resendResp.json();
    if (!resendResp.ok) console.error('Resend error:', resendResult);
    else console.log('Email sent:', resendResult.id);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
