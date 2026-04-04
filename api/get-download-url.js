import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { path } = req.body;
  if (!path) return res.status(400).json({ error: 'No path provided' });

  try {
    const { data, error } = await supabase.storage
      .from('loan-documents')
      .createSignedUrl(path, 300);

    if (error) {
      console.error('Signed URL error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ url: data.signedUrl });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
