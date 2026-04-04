import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SITE_URL = process.env.SITE_URL || 'https://northline-capital.com';

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
    // 1. Check if user already exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email === email);
    let userId = existingUser?.id || null;

    // 2. Invite or get existing user — Supabase Pro sends branded email automatically
    if (!existingUser) {
      const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
        data: { first_name: first, last_name: last },
      redirectTo: SITE_URL + '?portal=loan'
      });
      if (inviteError) {
        console.error('Invite error:', inviteError);
        return res.status(500).json({ error: inviteError.message });
      }
      userId = invited?.user?.id;
    } else {
      // User exists — generate a fresh magic link and send it
      const { error: otpError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo: SITE_URL }
      });
      if (otpError) console.error('OTP error:', otpError);
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

    if (leadError) {
      console.error('Lead error:', leadError);
      return res.status(500).json({ error: leadError.message });
    }

    // 4. Create loan pipeline entry
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

    // 5. Create default document checklist (only if none exist)
    const { data: existingDocs } = await supabase
      .from('documents')
      .select('id')
      .eq('lead_id', lead.id)
      .limit(1);

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

    return res.status(200).json({ success: true, message: 'Invite sent and loan record created' });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
