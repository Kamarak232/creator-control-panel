// Netlify serverless proxy — keeps GEMINI_API_KEY server-side
// All Gemini API calls from the frontend hit /api/gemini/* which redirects here
exports.handler = async (event) => {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Server API key not configured. Set GEMINI_API_KEY in Netlify environment variables.' } })
    };
  }

  // Extract the model path from the URL
  // e.g. /api/gemini/gemini-2.5-flash-preview-05-20:generateContent
  const pathParts = event.path.split('/api/gemini/');
  const modelPath = pathParts.length > 1 ? pathParts[1] : '';
  if (!modelPath) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { message: 'Missing model path.' } }) };
  }

  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelPath}?key=${KEY}`;

  try {
    const resp = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: { 'Content-Type': 'application/json' },
      body: event.body,
    });
    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};
