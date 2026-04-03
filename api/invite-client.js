import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS
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
    // 1. Invite user via Supabase Auth (sends magic link email automatically)
    const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { first_name: first, last_name: last },
      redirectTo: process.env.SITE_URL || 'https://clearrate.vercel.app'
    });

    if (inviteError && inviteError.message !== 'User already registered') {
      console.error('Invite error:', inviteError);
      return res.status(500).json({ error: inviteError.message });
    }

    const userId = inviteData?.user?.id;

    // 2. Upsert lead record
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .upsert({
        email,
        first_name: first,
        last_name: last,
        phone: phone || null,
        goal: goal || null,
        loan_balance: balance ? parseFloat(balance.replace(/[$,]/g, '')) : null,
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

    // 3. Create initial loan pipeline entry if it doesn't exist
    const { error: pipeError } = await supabase
      .from('loan_pipeline')
      .upsert({
        lead_id: lead.id,
        user_id: userId || null,
        stage: 'application',
        loan_amount: balance ? parseFloat(balance.replace(/[$,]/g, '')) : null,
        application_date: new Date().toISOString().split('T')[0]
      }, { onConflict: 'lead_id' });

    if (pipeError) {
      console.error('Pipeline error:', pipeError);
    }

    // 4. Create default document checklist
    const defaultDocs = [
      { name: '2024 W-2 / Tax Returns',           doc_type: 'w2',                status: 'pending_upload' },
      { name: 'Last 2 Pay Stubs',                  doc_type: 'pay_stub',          status: 'pending_upload' },
      { name: 'Bank Statements (2 months)',         doc_type: 'bank_statement',    status: 'pending_upload' },
      { name: "Homeowner's Insurance Declaration",  doc_type: 'insurance',         status: 'pending_upload' },
      { name: 'Current Mortgage Statement',         doc_type: 'mortgage_statement',status: 'pending_upload' },
      { name: 'Photo ID (Driver\'s License)',       doc_type: 'id',                status: 'pending_upload' }
    ];

    // Only insert docs if none exist yet
    const { data: existingDocs } = await supabase
      .from('documents')
      .select('id')
      .eq('lead_id', lead.id)
      .limit(1);

    if (!existingDocs || existingDocs.length === 0) {
      await supabase.from('documents').insert(
        defaultDocs.map(d => ({
          lead_id: lead.id,
          doc_type: d.doc_type,
          file_name: d.name,
          file_type: 'pending',
          storage_path: 'pending',
          status: d.status
        }))
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Client invited and loan record created'
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
