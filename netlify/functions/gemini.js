exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: { message: 'Invalid JSON body' } }) };
  }

  const { key, model, payload } = body;

  const apiKey = key || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'No API key available. Set GEMINI_API_KEY in Netlify environment variables.' } })
    };
  }

  if (!model || !payload) {
    return { statusCode: 400, body: JSON.stringify({ error: { message: 'Missing model or payload' } }) };
  }

  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gemini request timed out after 25 seconds')), 25000)
    );

    const geminiRes = await Promise.race([
      fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      timeout
    ]);

    const text = await geminiRes.text();
    return {
      statusCode: geminiRes.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: text,
    };
  } catch (err) {
    const isTimeout = err.message.includes('timed out');
    return {
      statusCode: isTimeout ? 504 : 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};
