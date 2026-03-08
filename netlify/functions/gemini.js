exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
  const { key, model, payload } = body;
  if (!key) return { statusCode: 400, body: JSON.stringify({ error: 'Missing API key' }) };
  if (!model) return { statusCode: 400, body: JSON.stringify({ error: 'Missing model' }) };
  if (!payload) return { statusCode: 400, body: JSON.stringify({ error: 'Missing payload' }) };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Gemini request timed out')), 25000)
  );
  try {
    const geminiRes = await Promise.race([
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      timeout
    ]);
    const text = await geminiRes.text();
    return { statusCode: geminiRes.status, headers: { 'Content-Type': 'application/json' }, body: text };
  } catch (err) {
    const is504 = err.message.includes('timed out');
    return { statusCode: is504 ? 504 : 502, body: JSON.stringify({ error: err.message }) };
  }
};
