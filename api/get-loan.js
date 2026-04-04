import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Get JWT from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const token = authHeader.replace('Bearer ', '');

  // Verify the token and get user
  const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    // Fetch lead by user_id or email
    let lead = null;
    const { data: leadByUserId } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (leadByUserId) {
      lead = leadByUserId;
    } else {
      const { data: leadByEmail } = await supabaseAdmin
        .from('leads')
        .select('*')
        .eq('email', user.email)
        .single();
      lead = leadByEmail;

      // Backfill user_id if missing
      if (lead && !lead.user_id) {
        await supabaseAdmin
          .from('leads')
          .update({ user_id: user.id })
          .eq('id', lead.id);
      }
    }

    if (!lead) {
      return res.status(404).json({ error: 'No loan found for this account' });
    }

    // Fetch pipeline
    const { data: pipeline } = await supabaseAdmin
      .from('loan_pipeline')
      .select('*')
      .eq('lead_id', lead.id)
      .single();

    // Backfill user_id on pipeline if missing
    if (pipeline && !pipeline.user_id) {
      await supabaseAdmin
        .from('loan_pipeline')
        .update({ user_id: user.id })
        .eq('id', pipeline.id);
    }

    // Fetch documents
    const { data: documents } = await supabaseAdmin
      .from('documents')
      .select('*, doc_files(*)')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: true });

    return res.status(200).json({
      lead: {
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email
      },
      pipeline: pipeline || null,
      documents: documents || []
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
