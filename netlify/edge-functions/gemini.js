export default async (request, context) => {
  const KEY = Deno.env.get('GEMINI_API_KEY');
  if (!KEY) {
    return new Response(
      JSON.stringify({ error: { message: 'Server API key not configured. Set GEMINI_API_KEY in Netlify environment variables.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
  const modelPath = url.pathname.replace('/api/gemini/', '');
  if (!modelPath) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing model path.' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelPath}?key=${KEY}`;
  const body = await request.text();

  const resp = await fetch(targetUrl, {
    method: request.method,
    headers: { 'Content-Type': 'application/json' },
    body: body,
  });

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
};

export const config = { path: '/api/gemini/*' };
