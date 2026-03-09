// Creator Control Panel — Web App
// All Gemini API calls made directly from the browser (no extension background needed).

const GEMINI_TEXT_MODEL = 'gemini-2.5-pro';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Returns true if API calls can be made (personal key stored, or deployed on Netlify with server-side key)
function hasApiAccess() {
  if (localStorage.getItem('geminiKey')) return true;
  const h = window.location.hostname;
  return h !== 'localhost' && h !== '127.0.0.1' && window.location.protocol !== 'file:';
}

// Cache the server-side key in memory so we only fetch it once per session
let _serverKey = null;
async function _getApiKey() {
  const local = localStorage.getItem('geminiKey');
  if (local) return local;
  if (_serverKey) return _serverKey;
  try {
    const res = await fetch('/api/key');
    const data = await res.json();
    if (data.key) { _serverKey = data.key; return _serverKey; }
  } catch (e) {}
  return '';
}

// Single entry point for all Gemini fetch calls — calls Gemini directly with key
async function _geminiFetch(model, payload) {
  const key = await _getApiKey();
  return fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function buildApiUrl(model) {
  const key = localStorage.getItem('geminiKey');
  if (key) return `${GEMINI_BASE}/${model}:generateContent?key=${key}`;
  return `${GEMINI_BASE}/${model}:generateContent?key=pending`;
}

// ─── In-memory character reference state ───────────────────────────────────
let _anchorImgData = null;
let _anchorImgMime = null;
let _secondaryAnchors = {};
let _styleReferencePrompt      = '';  // style prompt extracted from a user-supplied reference URL (Image Planner)
let _styleReferencePromptOther = '';  // style prompt extracted from a user-supplied reference URL (Other Niche)
let _styleRefImgData           = null; // base64 of the uploaded style reference image (Other Niche)
let _styleRefImgMime           = null; // mime type of the uploaded style reference image (Other Niche)

// ─── Storage helpers (localStorage replaces chrome.storage) ───────────────
function getGeminiKey() {
  return localStorage.getItem('geminiKey') || '';
}

function getSupadataKey() {
  return localStorage.getItem('supadataKey') || '';
}

function getProjects() {
  try { return JSON.parse(localStorage.getItem('projects') || '[]'); }
  catch { return []; }
}

function setProjects(projects) {
  localStorage.setItem('projects', JSON.stringify(projects));
}

// ─── Gemini Text API ──────────────────────────────────────────────────────
async function callGemini(systemPrompt, userPrompt) {
  const geminiKey = getGeminiKey();
  if (!hasApiAccess()) return { error: 'Add your Gemini API key in ⚙️ Settings.' };

  const model = localStorage.getItem('model') || GEMINI_TEXT_MODEL;

  let fullText = '';
  // Build up conversation turns for continuation calls
  const contents = [{ role: 'user', parts: [{ text: userPrompt }] }];

  // Allow up to 3 continuation passes to handle long outputs
  for (let pass = 0; pass < 3; pass++) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));

      try {
        const response = await _geminiFetch(model, {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { maxOutputTokens: 65536, temperature: 1.0 }
          });

        if (response.status === 503 || response.status === 429) {
          if (attempt === 0) continue;
          return { error: 'Gemini API is overloaded. Please wait a moment and try again.' };
        }

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const msg = err?.error?.message || `HTTP ${response.status}`;
          return { error: `API Error: ${msg}` };
        }

        const data = await response.json();
        const candidate = data?.candidates?.[0];
        const chunk = candidate?.content?.parts?.[0]?.text || '';
        const finishReason = candidate?.finishReason;

        // Empty on first real pass with no prior text — retry once before giving up
        if (!chunk) {
          if (pass === 0 && attempt === 0) { attempt--; await new Promise(r => setTimeout(r, 2000)); continue; }
          if (!fullText) return { error: 'Empty response from Gemini API.' };
          return { text: fullText };
        }

        fullText += chunk;

        // Clean finish — done
        if (finishReason === 'STOP' || finishReason === 'END_OF_TURN' || !finishReason) {
          return { text: fullText };
        }

        // Truncated — continue in next pass
        if (finishReason === 'MAX_TOKENS') {
          contents.push({ role: 'model', parts: [{ text: chunk }] });
          contents.push({ role: 'user', parts: [{ text: 'Continue exactly from where you stopped. Do not repeat anything already written.' }] });
          break; // move to next pass
        }

        // RECITATION / OTHER / SAFETY with partial text — return what we have
        if (fullText) return { text: fullText };
        // No text at all — retry
        if (attempt === 0) continue;

      } catch (err) {
        lastError = `Network Error: ${err.message}`;
      }
    }

    if (lastError) return { error: lastError };
  }

  // Returned all continuation passes — give back whatever we accumulated
  return fullText ? { text: fullText } : { error: 'Gemini stopped early. Try again.' };
}

// ─── Gemini Image Generation (Nano Banana) ────────────────────────────────
async function nanoBananaRender({ prompt, referenceImages }, _attempt = 0) {
  const geminiKey = getGeminiKey();
  if (!hasApiAccess()) return { error: 'Add your Gemini API key in ⚙️ Settings.' };

  const parts = [];
  if (referenceImages?.length) {
    for (const ref of referenceImages) {
      if (ref.data && ref.mime) parts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
    }
  }
  parts.push({ text: prompt });

  try {
    const response = await _geminiFetch('gemini-2.5-flash-image', {
        contents: [{ parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${response.status}`;

      // Rate limit with a suggested retry time → auto-wait and retry
      const retryMatch = msg.match(/retry in ([\d.]+)s/i);
      if (retryMatch && _attempt < 3) {
        const waitSec = Math.ceil(parseFloat(retryMatch[1])) + 2;
        showToast(`⏳ Rate limit — waiting ${waitSec}s then retrying…`, 'info');
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return nanoBananaRender({ prompt, referenceImages }, _attempt + 1);
      }
      // Quota exhausted (no retry time given) — billing limit, retrying won't help
      const isQuotaExhausted = /quota|rate.?limit|429/i.test(msg) || response.status === 429;
      if (isQuotaExhausted) {
        return { error: 'Image generation quota exhausted. Upgrade your Gemini API plan at ai.dev/rate-limit or wait until your quota resets.' };
      }

      return { error: `Nano Banana Error: ${msg}` };
    }

    const data = await response.json();
    const resParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = resParts.find(p => p.inlineData?.data);

    if (!imagePart) {
      return { error: `No image returned. Response: ${JSON.stringify(data).slice(0, 200)}` };
    }

    return {
      imageData: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || 'image/png'
    };
  } catch (err) {
    return { error: `Network Error: ${err.message}` };
  }
}

// ─── Gemini TTS ───────────────────────────────────────────────────────────
async function geminiTTS({ text, voice }) {
  const geminiKey = getGeminiKey();
  if (!hasApiAccess()) return { error: 'Add your Gemini API key in ⚙️ Settings.' };

  try {
    const response = await _geminiFetch('gemini-2.5-flash-preview-tts', {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
          }
        }
      });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${response.status}`;
      return { error: `Gemini TTS Error: ${msg}` };
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const audioParts = parts.filter(p => p.inlineData?.data);

    if (!audioParts.length) {
      return { error: `No audio returned. Response: ${JSON.stringify(data).slice(0, 200)}` };
    }

    const mimeType = audioParts[0].inlineData.mimeType || 'audio/pcm;rate=24000';
    return { audioParts: audioParts.map(p => p.inlineData.data), mimeType };
  } catch (err) {
    return { error: `Network Error: ${err.message}` };
  }
}

// ─── DOM helper ───────────────────────────────────────────────────────────
function get(id) { return document.getElementById(id); }

// ─── Init ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Always preserve API keys — read before anything touches localStorage
  const _savedKey      = localStorage.getItem('geminiKey');
  const _savedSupadata = localStorage.getItem('supadataKey');

  // Clear all content on every page load — keep API keys, model, projects
  const KEEP_KEYS = ['model', 'projects'];
  const preserved = {};
  KEEP_KEYS.forEach(k => { const v = localStorage.getItem(k); if (v !== null) preserved[k] = v; });
  localStorage.clear();
  KEEP_KEYS.forEach(k => { if (preserved[k] !== undefined) localStorage.setItem(k, preserved[k]); });

  // Always restore API keys — unconditionally
  if (_savedKey)      localStorage.setItem('geminiKey',   _savedKey);
  if (_savedSupadata) localStorage.setItem('supadataKey', _savedSupadata);

  // Ensure all niche items are hidden until a niche is selected
  document.querySelectorAll('.sidebar-niche-item, .sidebar-niche-label').forEach(el => el.style.display = 'none');
  initTabs();
  initListeners();
  loadProjects();
  restoreSettings();
});

const PAGE_META = {
  home:     ['Choose Your Niche', 'Select a channel niche to load the right tools'],
  prompt:   ['Script Generator',  'Generate full 15-minute scripts for your Stickman History videos'],
  script:   ['Script Refiner',    'Sharpen and polish your generated scripts'],
  images:   ['Image Planner',     'Plan visual beats and generate AI image prompts'],
  veo3:     ['Veo 3 Prompts',     'Generate motion prompts for image-to-video conversion'],
  voice:    ['Voice Generator',   'Convert your script into studio-quality narration'],
  medical:  ['Medical Curiosity', 'Generate body-horror medical scripts — Chubbyemu meets Kurzgesagt'],
  medimg:   ['Medical Image Planner', 'Generate storyboard image + video prompts for your medical script'],
  history:  ['Map History Script', 'Cinematic map-style geopolitics scripts — Vox meets Kings and Generals'],
  histimg:  ['Map History Image Planner', 'Generate frame-by-frame image prompts from your history script'],
  geo:      ['Geopolitical What-If Script', 'Analytical "what happens next" scripts — Last Brain Cell meets Wendover'],
  geoimg:   ['Geopolitical Image Planner', 'Generate frame-by-frame image prompts from your geopolitical script'],
  assembly: ['Video Assembly',     'Generate a beat-by-beat edit timeline from your finished assets'],
  other:    ['Video Analyser',     'Analyse any YouTube video and build a full production pipeline to match its style'],
  otherimg: ['Other Niche Image Planner', 'Generate image prompts matched to your reference video visual style'],
  compiler: ['Video Compiler',     'Auto-render all images, generate narration, and export a ready-to-stitch video package'],
  projects: ['Projects',          'Organise and manage your video projects'],
  settings: ['Settings',          'Configure your API key and generation preferences'],
};

const NICHE_TABS = {
  stickman: ['nav-stickman-label', 'nav-prompt', 'nav-script', 'nav-images', 'nav-veo3', 'nav-voice', 'nav-stickman-assembly'],
  medical:  ['nav-medical-label', 'nav-medical', 'nav-medical-script', 'nav-medical-images', 'nav-medical-veo3', 'nav-medical-voice', 'nav-medical-assembly'],
  history:  ['nav-history-label', 'nav-history', 'nav-history-script', 'nav-history-images', 'nav-history-veo3', 'nav-history-voice', 'nav-history-assembly'],
  geo:      ['nav-geo-label', 'nav-geo', 'nav-geo-script', 'nav-geo-images', 'nav-geo-veo3', 'nav-geo-voice', 'nav-geo-assembly'],
  other:    ['nav-other-label', 'nav-other', 'nav-other-script', 'nav-other-images', 'nav-other-veo3', 'nav-other-voice', 'nav-other-assembly'],
};

let currentNiche = null;
// Other-niche state
let currentOtherAnalysis    = '';  // raw analysis text from Gemini
let currentOtherStyle       = '';  // extracted visual style block
let currentOtherRuntime     = '';  // extracted video runtime
let currentOtherTopic       = '';  // selected topic text
let currentOtherVideoUrl    = '';  // reference video URL — used in Phase 3 for native video style analysis
let currentOtherTranscript       = '';  // full transcript text — used to mirror structure/length in script generation
let currentOtherVisualStyleGuide = '';  // 10-field style guide (ART STYLE … RECREATION PROMPT BASE) from Gemini video watch
let _otherScriptGen         = 0;   // increments on each topic click; only latest render wins
let _otherTopics            = [];  // all rendered topic objects — indexed by card position

// ─── Video Compiler state ──────────────────────────────────────────────────
let _compilerSegments   = [];
let _compilerStyleGuide = '';
let _compilerWavBlob    = null;

// ─── Pipeline State ────────────────────────────────────────────────────────
const PIPELINE_STEP_DEFS = [
  { key: 'script',   label: 'Script'   },
  { key: 'refiner',  label: 'Refiner'  },
  { key: 'images',   label: 'Images'   },
  { key: 'veo3',     label: 'Veo 3'    },
  { key: 'voice',    label: 'Voice'    },
  { key: 'assembly', label: 'Compiler' },
];

function getPipelineState(niche) {
  try { return JSON.parse(localStorage.getItem(`pipeline_${niche}`) || '{}'); }
  catch { return {}; }
}

function markPipelineStep(niche, stepKey) {
  if (!niche) return;
  const state = getPipelineState(niche);
  state[stepKey] = true;
  localStorage.setItem(`pipeline_${niche}`, JSON.stringify(state));
  renderPipelineBar(niche);
}

function renderPipelineBar(niche) {
  const bar = get('pipeline-bar');
  if (!niche) { bar.style.display = 'none'; return; }
  const state = getPipelineState(niche);
  bar.innerHTML = PIPELINE_STEP_DEFS.map((step, i) => {
    const done   = !!state[step.key];
    const cls    = done ? 'done' : '';
    const icon   = done ? '✓' : (i + 1);
    const conn   = i < PIPELINE_STEP_DEFS.length - 1
      ? `<div class="pipeline-connector${done ? ' done' : ''}"></div>`
      : '';
    return `<div class="pipeline-step ${cls}">
      <div class="pipeline-step-dot">${icon}</div>
      <span class="pipeline-step-label">${step.label}</span>
    </div>${conn}`;
  }).join('');
  bar.style.display = 'flex';
}

// ─── Autosave ──────────────────────────────────────────────────────────────
// Maps tab name → { textEl, outputEl } for auto-restore
const AUTOSAVE_TABS = {
  prompt:  { textEl: 'prompt-text',  outputEl: 'prompt-output'  },
  medical: { textEl: 'medical-text', outputEl: 'medical-output' },
  history: { textEl: 'history-text', outputEl: 'history-output' },
  geo:     { textEl: 'geo-text',     outputEl: 'geo-output'     },
  script:  { textEl: 'script-text',  outputEl: 'script-output'  },
};

const dirtyTabs = new Set(); // tabs with generated output not yet saved to a project

// Auto-fills the Script Refiner input from whichever niche script element is passed
function pushToRefiner(srcElId) {
  const src  = get(srcElId);
  const dest = get('script-input');
  if (src && dest && src.innerText.trim()) dest.value = src.innerText.trim();
}

function autosaveTab(tabName) {
  const cfg = AUTOSAVE_TABS[tabName];
  if (!cfg) return;
  const html = get(cfg.textEl)?.innerHTML || '';
  if (!html.trim()) return;
  try { localStorage.setItem(`autosave_${tabName}`, html); } catch(e) {}
  dirtyTabs.add(tabName);
}

function restoreTabIfEmpty(tabName) {
  const cfg = AUTOSAVE_TABS[tabName];
  if (!cfg) return;
  const textEl = get(cfg.textEl);
  if (!textEl || textEl.innerHTML.trim()) return; // already has content
  const saved = localStorage.getItem(`autosave_${tabName}`);
  if (!saved) return;
  textEl.innerHTML = saved;
  const outputEl = get(cfg.outputEl);
  if (outputEl) outputEl.style.display = 'flex';
  showToast('Restored from autosave', 'info');
}

function clearAutosaveDirty(tabName) {
  dirtyTabs.delete(tabName);
}

function selectNiche(niche) {
  currentNiche = niche;
  localStorage.setItem('lastNiche', niche);
  // Hide all niche nav items
  document.querySelectorAll('.sidebar-niche-item, .sidebar-niche-label').forEach(el => el.style.display = 'none');
  // Show items for selected niche
  (NICHE_TABS[niche] || []).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
  // Go to the first tool tab for this niche
  const firstTab = { stickman: 'prompt', medical: 'medical', history: 'history', geo: 'geo', other: 'other' }[niche] || 'prompt';
  renderPipelineBar(niche);
  switchTab(firstTab);
}

function initTabs() {
  document.querySelectorAll('.sidebar-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });
}

function switchTab(name) {
  // Warn if leaving a tab with unsaved generated content
  const leaving = document.querySelector('.ccp-panel.active');
  if (leaving) {
    const leavingTab = leaving.id.replace('tab-', '');
    if (dirtyTabs.has(leavingTab)) {
      showToast('Content auto-saved — use Save to Project to keep it permanently.');
    }
  }

  document.querySelectorAll('.sidebar-item').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.ccp-panel').forEach(p => p.classList.remove('active'));
  // When going home, hide all niche items
  if (name === 'home') {
    document.querySelectorAll('.sidebar-niche-item, .sidebar-niche-label').forEach(el => el.style.display = 'none');
    currentNiche = null;
    renderPipelineBar(null);
  }
  const navItem = document.querySelector(`.sidebar-item[data-tab="${name}"]:not([style*="display: none"]):not([style*="display:none"])`);
  if (navItem) navItem.classList.add('active');
  const panel = get(`tab-${name}`);
  if (panel) panel.classList.add('active');
  const [title, sub] = PAGE_META[name] || [name, ''];
  const titleEl = get('page-title');
  const subEl   = get('page-subtitle');
  if (titleEl) titleEl.textContent = title;
  if (subEl)   subEl.textContent   = sub || '';
  // Restore autosaved content if the output area is empty
  restoreTabIfEmpty(name);
  // Populate assembly tab from stored beat/voice data
  if (name === 'assembly') populateAssemblyTab();
  // Auto-populate Voice Generator with refined script
  if (name === 'voice') {
    const ttsInput = get('tts-input');
    const refined  = get('script-text')?.innerText.trim();
    if (ttsInput && refined && !ttsInput.value.trim()) ttsInput.value = refined;
  }
  // Auto-populate Video Compiler with script, title, and reference URL
  if (name === 'compiler') {
    const refined = get('script-text')?.innerText.trim();
    const compilerScript = get('compiler-script');
    if (compilerScript && refined && !compilerScript.value.trim()) compilerScript.value = refined;
    const compilerTitle = get('compiler-title');
    if (compilerTitle && !compilerTitle.value.trim()) {
      const topic = currentOtherTopic || get('history-topic')?.value.trim() || get('geo-topic')?.value.trim() || get('medical-title')?.value.trim() || '';
      if (topic) compilerTitle.value = topic;
    }
    const compilerUrl = get('compiler-url');
    if (compilerUrl && !compilerUrl.value.trim() && currentOtherVideoUrl) compilerUrl.value = currentOtherVideoUrl;
  }
  // Auto-fill image planner script textareas from Script Refiner output
  const imgScriptMap = { images: 'image-script', medimg: 'medimg-script', histimg: 'histimg-script', geoimg: 'geoimg-script', otherimg: 'otherimg-script' };
  if (imgScriptMap[name]) {
    const textarea = get(imgScriptMap[name]);
    const refinerText = get('script-text')?.innerText.trim();
    if (textarea && !textarea.value.trim() && refinerText) {
      textarea.value = refinerText;
    }
  }
  // Auto-fill other image planner topic from selected topic
  if (name === 'otherimg' && currentOtherTopic) {
    const topicEl = get('otherimg-topic');
    if (topicEl && !topicEl.value.trim()) topicEl.value = currentOtherTopic;
  }
}

function getActiveImageStyle() {
  if (_styleReferencePrompt) return 'the reference style';
  if (currentOtherVisualStyleGuide) {
    const match = currentOtherVisualStyleGuide.match(/ART STYLE:\s*(.+)/i);
    if (match) return match[1].trim();
  }
  return get('image-style').value;
}

function updateStyleLockBadge() {
  const badge = get('style-lock-badge');
  if (!badge) return;
  badge.style.display = currentOtherVisualStyleGuide ? 'inline-flex' : 'none';
}

function clearAll() {
  if (!confirm('Clear all generated content and start fresh?\n\nYour API key, model setting, and saved projects will be kept.')) return;

  // Always preserve API keys first — before anything else
  const _apiKey        = localStorage.getItem('geminiKey');
  const _supadataKey   = localStorage.getItem('supadataKey');

  const keep = ['model', 'projects'];
  const preserved = {};
  keep.forEach(k => { const v = localStorage.getItem(k); if (v !== null) preserved[k] = v; });

  localStorage.clear();

  keep.forEach(k => { if (preserved[k] !== undefined) localStorage.setItem(k, preserved[k]); });

  // Always restore API keys — unconditionally
  if (_apiKey)      localStorage.setItem('geminiKey',   _apiKey);
  if (_supadataKey) localStorage.setItem('supadataKey', _supadataKey);

  // Clear all textareas and output elements
  document.querySelectorAll('textarea').forEach(el => { el.value = ''; });
  document.querySelectorAll('.ccp-output').forEach(el => { el.style.display = 'none'; });
  document.querySelectorAll('[id$="-text"]').forEach(el => { el.innerHTML = ''; });
  document.querySelectorAll('[id$="-list"]').forEach(el => { el.innerHTML = ''; });
  document.querySelectorAll('[id$="-result"]').forEach(el => { el.innerHTML = ''; });

  // Remove download button if present
  const dlBtn = get('assembly-download-btn');
  if (dlBtn) dlBtn.remove();

  // Reset niche + UI state
  currentNiche = null;
  dirtyTabs.clear();
  document.querySelectorAll('.sidebar-niche-item, .sidebar-niche-label').forEach(el => el.style.display = 'none');
  get('pipeline-bar').style.display = 'none';
  get('pipeline-bar').innerHTML = '';
  switchTab('home');

  currentOtherVisualStyleGuide = '';
  updateStyleLockBadge();
  showToast('Cleared — ready for a new video.', 'success');
}

function initListeners() {
  get('clear-all-btn').addEventListener('click', clearAll);

  // Script Generator
  get('generate-prompt-btn').addEventListener('click', generatePrompt);
  get('copy-prompt-btn').addEventListener('click', () => copyText(get('prompt-text').textContent));
  get('save-prompt-btn').addEventListener('click', savePromptToProject);

  // Medical Curiosity
  get('generate-medical-btn').addEventListener('click', generateMedical);
  get('copy-medical-btn').addEventListener('click', () => copyText(get('medical-text').textContent));
  get('generate-medimg-btn').addEventListener('click', generateMedicalImages);
  get('copy-medimg-btn').addEventListener('click', () => copyText(get('medimg-list').innerText));
  get('generate-history-btn').addEventListener('click', generateHistory);
  get('copy-history-btn').addEventListener('click', () => copyText(get('history-text').textContent));
  get('save-history-btn').addEventListener('click', () => {
    const text = get('history-text').textContent;
    if (!text) return;
    const project = { id: Date.now(), title: get('history-topic').value.trim() || 'History Script', notes: text, date: new Date().toLocaleDateString() };
    const projects = getProjects(); projects.unshift(project); setProjects(projects);
    clearAutosaveDirty('history');
    showToast('Saved to Projects!');
  });
  get('generate-histimg-btn').addEventListener('click', generateHistoryImages);
  get('copy-histimg-btn').addEventListener('click', () => copyText(get('histimg-list').innerText));
  get('generate-geo-btn').addEventListener('click', generateGeo);
  get('copy-geo-btn').addEventListener('click', () => copyText(get('geo-text').textContent));
  get('generate-geoimg-btn').addEventListener('click', generateGeoImages);
  get('copy-geoimg-btn').addEventListener('click', () => copyText(get('geoimg-list').innerText));
  get('save-geo-btn').addEventListener('click', () => {
    const text = get('geo-text').textContent;
    if (!text) return;
    const project = { id: Date.now(), title: get('geo-topic').value.trim() || 'Geopolitical Script', notes: text, date: new Date().toLocaleDateString() };
    const projects = getProjects(); projects.unshift(project); setProjects(projects);
    clearAutosaveDirty('geo');
    showToast('Saved to Projects!');
  });
  get('save-medical-btn').addEventListener('click', () => {
    const text = get('medical-text').textContent;
    if (!text) return;
    const project = { id: Date.now(), title: get('medical-title').value.trim() || 'Medical Script', notes: text, date: new Date().toLocaleDateString() };
    const projects = getProjects();
    projects.unshift(project);
    setProjects(projects);
    clearAutosaveDirty('medical');
    showToast('Saved to Projects!');
  });

  // Other / Other Niche
  get('analyze-video-btn').addEventListener('click', analyzeReferenceVideo);
  get('more-topics-btn').addEventListener('click', generateMoreTopicIdeas);
  get('generate-other-btn').addEventListener('click', generateOtherScript);
  get('copy-other-btn').addEventListener('click', () => copyText(get('other-text').textContent));
  get('save-other-btn').addEventListener('click', () => {
    const text = get('other-text').textContent;
    if (!text) return;
    const project = { id: Date.now(), title: currentOtherTopic || 'Other Niche Script', notes: text, date: new Date().toLocaleDateString() };
    const projects = getProjects(); projects.unshift(project); setProjects(projects);
    showToast('Saved to Projects!');
  });
  get('generate-otherimg-btn').addEventListener('click', generateOtherImages);
  get('extract-style-ref-other-btn').addEventListener('click', extractStyleReferenceOther);
  get('clear-style-ref-other-btn').addEventListener('click', clearStyleReferenceOther);
  get('style-reference-file-other').addEventListener('change', e => {
    const f = e.target.files?.[0];
    get('style-file-name-other').textContent = f ? f.name : 'Click to upload a reference image…';
  });
  get('copy-otherimg-btn').addEventListener('click', () => copyText(get('otherimg-list').innerText));

  // Video Compiler
  get('run-compiler-btn').addEventListener('click', runVideoCompiler);

  // Script Refiner
  get('optimize-script-btn').addEventListener('click', optimizeScript);
  get('copy-script-btn').addEventListener('click', () => copyText(get('script-text').textContent));

  // Image Planner
  get('reset-images-btn').addEventListener('click', resetImagePlanner);
  get('extract-style-ref-btn').addEventListener('click', extractStyleReference);
  get('clear-style-ref-btn').addEventListener('click', clearStyleReference);
  get('suggest-anchor-btn').addEventListener('click', suggestCharacterLooks);
  get('plan-images-btn').addEventListener('click', planImages);
  get('copy-all-beats-btn').addEventListener('click', copyAllBeats);
  get('render-all-beats-btn').addEventListener('click', renderAllBeats);
  get('render-all-otherimg-btn').addEventListener('click', renderAllBeats);
  document.addEventListener('click', e => {
    const copyBtn = e.target.closest('.beat-copy-btn');
    if (copyBtn) copyText(copyBtn.closest('.beat-item').querySelector('.beat-prompt').textContent);

    const renderBtn = e.target.closest('.beat-render-btn');
    if (renderBtn) renderBeatImage(renderBtn);

    const rerenderBtn = e.target.closest('.beat-rerender-btn');
    if (rerenderBtn) renderBeatImage(rerenderBtn.closest('.beat-item').querySelector('.beat-render-btn'));
  });

  // Veo 3
  get('generate-veo3-btn').addEventListener('click', generateVeo3Prompts);
  get('copy-all-veo3-btn').addEventListener('click', copyAllVeo3);
  get('veo3-prompts-list').addEventListener('click', e => {
    const copyBtn = e.target.closest('.veo3-copy-btn');
    if (copyBtn) copyText(copyBtn.closest('.veo3-item').querySelector('.veo3-prompt').textContent);
  });

  // Find Fresh Topic
  get('find-topic-stickman-btn').addEventListener('click', () => findFreshTopic('stickman'));
  get('find-topic-medical-btn').addEventListener('click',  () => findFreshTopic('medical'));
  get('find-topic-history-btn').addEventListener('click',  () => findFreshTopic('history'));
  get('find-topic-geo-btn').addEventListener('click',      () => findFreshTopic('geo'));

  // Video Assembly
  get('generate-assembly-btn').addEventListener('click', generateAssembly);
  get('copy-assembly-btn').addEventListener('click', () => copyText(get('assembly-result').innerText));

  // Voice
  get('generate-tts-btn').addEventListener('click', generateTTS);

  // Projects
  get('new-project-toggle-btn').addEventListener('click', () => toggleForm('new-project-form'));
  get('cancel-project-btn').addEventListener('click', () => hideForm('new-project-form'));
  get('save-project-btn').addEventListener('click', saveNewProject);
  get('projects-list').addEventListener('click', e => {
    const del = e.target.closest('.project-delete');
    if (del) deleteProject(Number(del.dataset.id));
  });

  // Settings
  get('save-gemini-key-btn').addEventListener('click', saveGeminiKey);
  get('save-supadata-key-btn').addEventListener('click', saveSupadataKey);
  get('save-model-btn').addEventListener('click', saveModel);
}

// ─── Script Generator ─────────────────────────────────────────────────────
async function generatePrompt() {
  const role    = get('prompt-role').value.trim();
  const setting = get('prompt-setting').value.trim();
  const gender  = get('prompt-gender').value;
  const ending  = get('prompt-ending').value;

  if (!role)    return showToast('Please enter a role or subject.', 'error');
  if (!setting) return showToast('Please enter the historical setting.', 'error');

  const btn = get('generate-prompt-btn');
  setLoading(btn, '⚡ Generate Script');

  // ── Helpers ───────────────────────────────────────────────────────────────
  function isNarrBlock(block) {
    const t = block.trim();
    if (!t) return false;
    if (/^\*?\[VISUAL/i.test(t)) return false;
    if (/^\*?\[MUSIC/i.test(t)) return false;
    if (/^\*?\[HOLD/i.test(t)) return false;
    if (/^##\s+PART/i.test(t)) return false;
    if (/^\*\*\[END/i.test(t)) return false;
    if (/^-{3,}/.test(t)) return false;
    return true;
  }
  function countSpokenWords(text) {
    return text.split(/\n\s*\n/).filter(isNarrBlock).join(' ').trim().split(/\s+/).filter(Boolean).length;
  }

  const SYS = `You are a cinematic YouTube scriptwriter for historically grounded stickman animation channels. You write exclusively in second-person ("You"). You follow formatting and length instructions with absolute precision. You never stop early, never summarise, and you always write every section to its full required length.`;

  const STYLE = `VOICE AND STYLE:
Write entirely in second-person. Every sentence uses "you." Never drift into third-person.
Sentences are short. Punchy. Some are fragments. Vary length deliberately. Short sentences land like a fist.
No modern slang. No jokes. No emojis. No heroism. No romance. Tone is cold, precise, cinematic.
Focus on systems and power — not individuals. The subject is a body the system found a use for.
Sensory detail must be physical and specific: smells, textures, temperatures, sounds.

PARAGRAPH RULES:
Each paragraph is 3–5 sentences. Follow a dense paragraph with a short one (1–2 sentences).
At least one standalone single-sentence line per section. Examples: "You row." / "It does not come."
Emotional weight comes from restraint. End each section quietly — not dramatically.

FORMAT:
Begin each section with:
*[VISUAL: minimal cinematic description]*
*[MUSIC: one-line tone and instrument]*
Then write the narration under the section header.`;

  // ── Generate all 8 sections individually ─────────────────────────────────
  const sections = [
    {
      num: 'ONE', title: 'OPENING IMMERSION', words: 250,
      brief: `Start with exact words: "You were born in ${setting}." Anchor the year, geography, family, daily sounds and smells. End with a quiet line that implies danger without naming it.`
    },
    {
      num: 'TWO', title: 'EARLY LIFE', words: 260,
      brief: `Show how power works before it breaks. Class structure, daily routine, gender roles, the myth people believe to feel safe. One thing a parent does that is preparation for danger — the subject doesn't know that yet. End on the last ordinary moment.`
    },
    {
      num: 'THREE', title: 'THE RISING THREAT', words: 250,
      brief: `Introduce the force that will destroy the subject's world. Build slowly — approach it like news travels: fragments, other people's faces, things not said. Include one fragment line that signals the tonal shift.`
    },
    {
      num: 'FOUR', title: 'THE SYSTEM CRUSH', words: 260,
      brief: `Institutional machinery takes over. The subject is assessed, classified, assigned. Use dehumanizing language: "You are counted." "You are assigned." Show one family member's reaction through physical behavior only — no dialogue naming the emotion. End with the subject walking away. "The road does not care who you are."`
    },
    {
      num: 'FIVE', title: 'ADAPTATION', words: 250,
      brief: `Describe the new environment through smell first, then sight. Show survival rules. Include this exact pivot: "You stop thinking like a [what they were]. You start thinking like a [what the system made them]." Then: "This is not weakness. This is survival." End with one wordless act of humanity passed between subjects.`
    },
    {
      num: 'SIX', title: 'FALSE HOPE', words: 250,
      brief: `Introduce something that makes the future feel genuinely possible. Make it completely real — do not telegraph collapse. Show the subject imagining a specific physical future. End on the subject counting something. They have begun to count.`
    },
    {
      num: 'SEVEN', title: 'THE REVERSAL', words: 250,
      brief: `The system takes the hope back. Not through a villain. Through paperwork. Institutional convenience. A decision by people who never met the subject. End with three short parallel lines describing the subject's condition without naming the emotion. Then: a variation of "Not [dramatic fate]. Simply: not attended to." Ending type: ${ending}`
    },
    {
      num: 'EIGHT', title: 'PHILOSOPHICAL ZOOM OUT', words: 230,
      brief: `Step back from the subject. Name what the official narrative calls this period — the triumphant version. Then show what it leaves out. End with 4 lines: what the subject did, what the world gave them in return, what history calls them now, and the final quiet truth.`
    }
  ];

  const parts = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    btn.textContent = `⏳ Writing Part ${i + 1} of 8…`;

    const context = parts.length > 0
      ? `\n\nSCRIPT SO FAR (for continuity — do NOT repeat any of this):\n${parts.slice(-2).join('\n\n---\n\n')}`
      : '';

    const prompt = `${STYLE}

Role: ${role} | Setting: ${setting} | Gender: ${gender}

Write ONLY ## PART ${s.num}: ${s.title} now. Nothing else. No other sections.

SECTION BRIEF: ${s.brief}

TARGET: Exactly ${s.words} spoken narration words for this section only. Count carefully. Do not stop until you hit ${s.words} words.

Begin with the header: ## PART ${s.num}: ${s.title}
Then: *[VISUAL: ...]* and *[MUSIC: ...]*
Then write the narration.${context}`;

    const r = await callGemini(SYS, prompt);
    if (r.error) { setLoading(btn, '⚡ Generate Script', false); return showToast(r.error, 'error'); }

    let partText = r.text.trim();
    // If section came up short, do one extension pass
    const partWords = countSpokenWords(partText);
    if (partWords < s.words - 30) {
      btn.textContent = `⏳ Extending Part ${i + 1} (${partWords}/${s.words} words)…`;
      const ext = await callGemini(SYS,
        `The section below has only ${partWords} spoken words but needs ${s.words}. Continue the narration from exactly where it ended. No header. No stage directions. Just more narration paragraphs (3–5 sentences each) until you hit ${s.words} total words for this section.\n\nSECTION SO FAR:\n${partText}\n\nContinue:`
      );
      if (!ext.error && ext.text) partText = partText + '\n\n' + ext.text.trim();
    }

    parts.push(partText);
  }

  // ── Add ending card ───────────────────────────────────────────────────────
  const endCard = `*[VISUAL: Fade to black. A single line of factual text appears — one real historical fact about this subject that most people do not know.]*

*[Hold. Silence. Then one specific ambient sound from the subject's world. Once. Then nothing.]*

**[END CARD NOTE: Hold black for four full seconds. No music sting. No call to action. Let it sit.]*`;

  const script = parts.join('\n\n') + '\n\n' + endCard;

  // ── Render ────────────────────────────────────────────────────────────────
  setLoading(btn, '⚡ Generate Script', false);
  const finalWords = countSpokenWords(script);
  const finalMins  = Math.round(finalWords / 130);
  const outputHeader = get('prompt-output').querySelector('.ccp-output-label');
  if (outputHeader) outputHeader.textContent = `Generated Script — ${finalWords.toLocaleString()} spoken words · ~${finalMins} min`;

  const blocks = script.split(/\n\s*\n/).filter(b => b.trim());
  get('prompt-text').innerHTML = blocks.map(block => {
    const t = block.trim();
    const isDir = /^\*?\[VISUAL/i.test(t) || /^\*?\[MUSIC/i.test(t) || /^\*?\[HOLD/i.test(t) || /^\*\*\[END/i.test(t);
    const isHeader = /^##\s+PART/i.test(t);
    if (isDir) return `<p style="margin:6px 0 14px;color:#7c6fa0;font-size:11px;font-style:italic;">${t.replace(/\n/g, '<br>')}</p>`;
    if (isHeader) return `<p style="margin:20px 0 8px;color:#c084fc;font-size:12px;font-weight:700;letter-spacing:0.05em;">${t}</p>`;
    return `<p style="margin:0 0 14px;">${t.replace(/\n/g, ' ')}</p>`;
  }).join('');
  show('prompt-output');
  pushToRefiner('prompt-text');
  autosaveTab('prompt');
  markPipelineStep(currentNiche, 'script');
}

// ─── Medical Curiosity Script Generator ───────────────────────────────────
async function generateMedical() {
  const title = get('medical-title').value.trim();
  if (!title) return showToast('Please enter a video title or topic.', 'error');

  const btn = get('generate-medical-btn');
  setLoading(btn, '🧬 Generate Medical Script');

  const SYS = `You are the lead scriptwriter for a viral "Medical Curiosity" YouTube channel — a mix of Chubbyemu's medical horror and Kurzgesagt's existential dread. You write clinical but morbidly funny narration at a 6th grade reading level. You never use visual cue brackets like [Cut to]. You never open with "Hello" or "Welcome." You always dive straight into the scenario in the very first sentence.`;

  const prompt = `VIDEO TITLE: ${title}

Write a spoken narration script of approximately 1,150 words based on the video title above. Structure it as a chronological journey through the human body using the following format:

---

## THE HOOK (0:00 – 1:00)
- First sentence MUST verbally match the concept in the title. No greeting. No intro. Dive straight in.
- Briefly describe what the viewer thinks would happen (the mild/positive expectation).
- Then hint at the disaster: "You might think X, but by [time marker], your [organ] is doing Y."

## THE HONEYMOON PHASE (1:00 – 3:00)
Time marker: "Day 1" or "Week 1"
- Describe the initial sensations and how the body compensates well at first.
- Explain the immediate biological reaction (adrenaline, insulin spikes, etc.) in plain language.
- Soft CTA: "If you've ever wondered why [topic] feels so [X] at first, like this video."

## THE SHIFT (3:00 – 5:00)
Time marker: "Week 2" or "Month 1"
- Pause the narrative briefly: "To understand what happens next, I went through [X] autopsy reports / medical journals so you don't have to..."
- Explain the hidden damage. The body stops compensating and starts suffering.
- Name the specific organ or system that starts failing and why.

## THE CRASH (5:00 – 7:30)
Time marker: "Day 60" or "The Surgery" or equivalent
- This is the climax. Describe the specific organ failure, psychological breakdown, or gruesome historical procedure in vivid, visceral but clear detail.
- Use the "running hot" metaphor: the body working overtime just to survive.
- Hard CTA: "Before we see if you make it past [time marker], hit Subscribe to keep your own organs functioning."

## THE AFTERMATH (7:30 – End)
- Describe the final state of the body: permanent damage, death, or long recovery.
- Give a philosophical or medical summary sentence. ("The human body is resilient, but it wasn't designed to...")
- End with a specific curiosity question for the comments. Make it something the viewer will genuinely want to answer.

---

TONE: Clinical but morbidly funny. "Smart friend telling a scary story at a campfire." 6th grade reading level.
WORD COUNT: 1,100–1,200 spoken words. Count carefully.
NO visual cue brackets. Describe visuals through the narration (e.g., "Imagine your kidneys are now filtering sludge instead of blood").
USE time markers or procedural steps to create forward momentum throughout.

Begin immediately with the hook. No preamble.`;

  const r1 = await callGemini(SYS, prompt);
  if (r1.error) { setLoading(btn, '🧬 Generate Medical Script', false); return showToast(r1.error, 'error'); }
  let script = r1.text;

  // Extend if short
  const wordCount = script.trim().split(/\s+/).length;
  if (wordCount < 1050) {
    btn.textContent = '⏳ Extending script…';
    const ext = await callGemini(SYS,
      `The script below is only ${wordCount} words. The target is 1,100–1,200 words. Continue from the exact last word — no headers, no preamble. Just continue the narration until you hit 1,100 words total.\n\nSCRIPT:\n${script}\n\nContinue:`
    );
    if (!ext.error && ext.text) script = script.trimEnd() + '\n\n' + ext.text.trim();
  }

  setLoading(btn, '🧬 Generate Medical Script', false);
  const finalWords = script.trim().split(/\s+/).length;
  const outputHeader = get('medical-output').querySelector('.ccp-output-label');
  if (outputHeader) outputHeader.textContent = `Medical Script — ${finalWords.toLocaleString()} words`;

  const blocks = script.split(/\n\s*\n/).filter(b => b.trim());
  get('medical-text').innerHTML = blocks.map(block => {
    const t = block.trim();
    const isHeader = /^##\s/.test(t);
    if (isHeader) return `<p style="margin:20px 0 8px;color:#c084fc;font-size:12px;font-weight:700;letter-spacing:0.05em;">${t}</p>`;
    return `<p style="margin:0 0 14px;">${t.replace(/\n/g, ' ')}</p>`;
  }).join('');
  show('medical-output');
  pushToRefiner('medical-text');
  autosaveTab('medical');
  markPipelineStep(currentNiche, 'script');
}

// ─── Medical Image Planner ────────────────────────────────────────────────
async function generateMedicalImages() {
  const script = get('medimg-script').value.trim();
  if (!script) return showToast('Please paste a script segment first.', 'error');

  const btn = get('generate-medimg-btn');
  setLoading(btn, '🖼 Generate Image Prompts');

  const SYS = `You are an Expert Medical Storyboard Director, Anatomist, and Cinematographer functioning as a text-to-image prompt engineer. You do NOT generate images. You output ONLY a numbered list of detailed text prompts. For every image prompt you also write a brief video prompt (for Grok). You follow the Stickman Medical Style with absolute precision.`;

  const prompt = `ACT AS: An Expert Medical Storyboard Director, Anatomist, and Cinematographer.
YOUR GOAL: For the script segment below, generate one image prompt AND one video prompt per sentence or distinct thought. DO NOT GENERATE IMAGES. Output only the text prompts.

PHASE 1 — SCENE TYPE LOGIC:
TYPE A (External/Social/Metaphorical): Trigger = habits, social situations, myths, metaphors.
  Visual: Full environment with the Main Stickman Character acting out the scene. Other characters must look distinct (different heights, accessories). Composition: Rule of Thirds or Golden Ratio.
TYPE B (Internal/Biological/Anatomical): Trigger = organs, cells, chemicals, internal pain.
  Visual Option 1 (X-Ray): Stickman with transparent skin, showing the specific organ in correct anatomical position.
  Visual Option 2 (Macro): NO Stickman. High-end medical macro shot of tissue/cell/organ.
  CONSTRAINT: Strict anatomical correctness. Never show wrong organ for the body part mentioned.

PHASE 2 — ART STYLE DNA:
MAIN CHARACTER: "A high-quality 2D vector art Stickman, round white head with simple hair and facial hair if necessary, solid bold black geometric body lines (no tapering), clean distinct mitten-hands (no noodle arms), wearing a sea green jacket with red neck tie."
ANATOMY STYLE: "Biologically accurate but stylized, clean textures, glowing translucent tissues, cross-section views, vibrant medical color palette (reds, blues, purples), no gore, educational aesthetic."
EVERY PROMPT must end with: "Style: Premium vector illustration, flat design with volumetric lighting, ambient occlusion, soft cinematic shadows, clean lines, 4k resolution, medical pop-art aesthetic, highly detailed background, trending on Behance."

PHASE 3 — OUTPUT FORMAT (repeat for every sentence):
[SCENE NUMBER] - [Sentence Segment]
Prompt: [Shot Composition] showing [Detailed Action & Subject]. [Environment/Background]. [Anatomical details if applicable]. Style: High-fidelity 2D vector art Stickman, round white head with hair and facial hair if necessary, solid bold black geometric body lines, clean distinct mitten-hands, sea green jacket with red neck tie, Premium vector illustration, flat design with volumetric lighting, ambient occlusion, soft cinematic shadows, clean lines, 4k resolution, medical pop-art aesthetic, highly detailed background, cinematic lighting. Lighting: [Specific lighting]. --ar 16:9
Video Prompt: [One-line motion/animation description for Grok]

CRITICAL RULES:
- NO SKIPPING. Generate a prompt for every single sentence.
- ANATOMY CHECK: Verify anatomical location before writing any organ prompt.
- If script implies a sign or label, describe it visually.

SCRIPT SEGMENT:
${script}

Begin immediately with Scene 1.`;

  const result = await callGemini(SYS, prompt);
  if (result.error) { setLoading(btn, '🖼 Generate Image Prompts', false); return showToast(result.error, 'error'); }

  setLoading(btn, '🖼 Generate Image Prompts', false);

  // Parse and render scenes
  const scenes = result.text.split(/\n(?=\[\d+\])/).filter(s => s.trim());
  const list = get('medimg-list');

  if (scenes.length === 0) {
    // Fallback: render as plain blocks
    list.innerHTML = result.text.split(/\n\s*\n/).filter(b => b.trim()).map(b =>
      `<div style="background:rgba(124,58,237,0.06);border:1px solid rgba(124,58,237,0.15);border-radius:10px;padding:14px 16px;margin-bottom:12px;font-size:12px;line-height:1.7;color:var(--text2);">${b.trim().replace(/\n/g, '<br>')}</div>`
    ).join('');
  } else {
    list.innerHTML = scenes.map(scene => {
      const lines = scene.trim().split('\n');
      const header = lines[0];
      const body = lines.slice(1).join('\n');
      const isVideoLine = (l) => /^video prompt:/i.test(l.trim());
      const promptLines = body.split('\n').filter(l => !isVideoLine(l) && l.trim()).join('<br>');
      const videoLine = body.split('\n').find(isVideoLine) || '';
      return `<div style="background:rgba(124,58,237,0.06);border:1px solid rgba(124,58,237,0.15);border-radius:10px;padding:14px 16px;margin-bottom:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--accent-hi);margin-bottom:8px;">${header}</div>
        <div style="font-size:12px;line-height:1.7;color:var(--text2);margin-bottom:${videoLine ? '10px' : '0'};">${promptLines}</div>
        ${videoLine ? `<div style="font-size:11px;line-height:1.6;color:#7c6fa0;border-top:1px solid rgba(124,58,237,0.12);padding-top:8px;margin-top:4px;">${videoLine.trim()}</div>` : ''}
      </div>`;
    }).join('');
  }

  show('medimg-output');
  markPipelineStep(currentNiche, 'images');
}

// ─── Map History Script Generator ────────────────────────────────────────
async function generateHistory() {
  const topic = get('history-topic').value.trim();
  if (!topic) return showToast('Please enter a topic.', 'error');

  const btn = get('generate-history-btn');
  setLoading(btn, '🗺️ Generate History Script');

  const SYS = `You are an expert educational video scriptwriter specializing in cinematic map-style history and geopolitics content (in the style of Vox, RealLifeLore, Kings and Generals). You follow formatting and length instructions with absolute precision. You always deliver the full script with all inline markers, the Act Summary Table, and word count. You never truncate or summarize — you write every paragraph in full.`;

  const prompt = `Write a complete, FULL-LENGTH video script on the topic of: ${topic}

---

STRICT RULES — FOLLOW EXACTLY:

LENGTH & STRUCTURE:
- Total runtime: ~15 minutes (minimum 2,250 spoken words — count ONLY text on [VOICEOVER] lines)
- Format: 1 extended Intro + 10–12 numbered Acts (Roman numerals) + 1 full Conclusion
- Each Act = ~1.5 minutes of content (minimum 200–250 spoken words across multiple paragraphs + production notes)
- Acts must be chronological or logically sequential
- DO NOT truncate or summarise Acts — write every sentence in full

SCRIPT FORMAT — USE THESE INLINE MARKERS EVERY TIME:
- [VOICEOVER] — a block of spoken narration (2–4 sentences per block, multiple blocks per Act)
- [ON-SCREEN TEXT] — any title, label, date, banner, or callout that appears on screen
- [ANIMATION NOTE] — describe the map/graphic animation that plays during this moment
- [TRANSITION] — how the scene moves to the next (cut, zoom, wipe, fade, dissolve)
- [AUDIO NOTE] — music mood, sound effects, or pacing shift

---

INTRO (00:00 – ~01:30)
Open with a strong hook that creates a central tension or mystery about the topic.
- Write 3–4 [VOICEOVER] paragraphs (2–4 sentences each)
- Contrast two opposing ideas, time periods, or perceptions of the same subject
- Use map animations to establish geography immediately
- End the intro with a clear thesis sentence telling the viewer exactly what they'll learn

---

ACTS I–XII (~01:30 – ~13:45)
Each Act must follow this exact internal structure AND contain enough paragraphs to reach ~200–250 spoken words:

### [ACT NUMBER IN ROMAN NUMERAL — ACT TITLE — ERA/PHASE NAME — DATE RANGE]

[AUDIO NOTE] Describe the music shift and any sound effects that open this era
[ANIMATION NOTE] What the map does at the very start of this act
[ON-SCREEN TEXT] Act title banner + timeline UI label (e.g. "III — OTTOMAN EXPANSION (1453–1683)")

[VOICEOVER] Opening paragraph — 3–4 sentences that set the scene for this era. Establish geography, power balance, and stakes.

[ANIMATION NOTE] Visual that supports the opening paragraph

[VOICEOVER] Second paragraph — 3–4 sentences on the core events: what happened, who drove it, what changed on the map.

[ANIMATION NOTE] Map movement — borders expanding, shrinking, colour shifts, troop movements, or city labels

[ON-SCREEN TEXT] Key dates, leader names, battle names, treaty names, or territory labels

[VOICEOVER] Third paragraph — 3–4 sentences: the consequence, turning point, or legacy of these events. Include one surprising or counterintuitive fact.

[ANIMATION NOTE] Visual consequence — a border that shifts dramatically, a city that falls, a new colour appearing on the map

[VOICEOVER] Closing paragraph for this act — 2–3 sentences that bridge to the next era and raise the next question

[TRANSITION] How this act ends and the next begins

---

CONCLUSION (~13:45 – 15:00)
- Write 4–5 [VOICEOVER] paragraphs — this is a full segment, not a single line
- Rapid visual montage recapping all eras — describe each animation beat
- Return to the central tension introduced in the Intro — now resolve it with the evidence of the Acts
- Final [VOICEOVER] paragraph must be emotionally resonant, poetic, and memorable — end on a single powerful sentence about survival, identity, legacy, or transformation

---

TONE & STYLE RULES:
- Voice is authoritative, measured, slightly dramatic — never casual or chatty
- Vary sentence length: short punchy statements alternate with longer flowing historical descriptions
- Use contrast structures: "While X was collapsing... Y was quietly rising..." / "Yet despite this..."
- Every Act must contain at least one surprising or counterintuitive fact
- Never editorialize — stay objective and let the facts carry the weight
- Rhetorical questions allowed sparingly (max 3 per script)
- Never write "[continued]", "[more to come]", or any placeholder — write the complete text

COLOR-CODING SYSTEM (reference in every animation note that shows territory):
- Subject nation/entity: Deep Red or Burgundy
- Rival empire or antagonist: Blue
- Conquering/invading force: Dark Green or Gold
- Foreign colonial powers: Orange
- Allied or neutral states: Grey
- Base map: Parchment/cream texture with pale blue water

---

DELIVER IN THIS ORDER:
1. Act Summary Table at the TOP — one row per Act showing Roman numeral, Act title, and timestamp range
2. Full script — every word, every marker, every paragraph — no truncation
3. Final spoken word count on the last line (count [VOICEOVER] text only)

Begin immediately with the Act Summary Table. Then write the complete script without stopping.`;

  const r1 = await callGemini(SYS, prompt);
  if (r1.error) { setLoading(btn, '🗺️ Generate History Script', false); return showToast(r1.error, 'error'); }
  let script = r1.text;

  // Extend if spoken words fall short of 15-minute target
  const voiceWords = script.split('\n')
    .filter(l => l.trim().startsWith('[VOICEOVER]'))
    .join(' ').split(/\s+/).filter(Boolean).length;

  if (voiceWords < 2000) {
    btn.textContent = `⏳ Extending… (${voiceWords} spoken words so far)`;
    const ext = await callGemini(SYS,
      `The script below has only ${voiceWords} spoken words in [VOICEOVER] lines. The target is a minimum of 2,250 words for a 15-minute video. Expand the thinnest Acts — those with fewer than 3 [VOICEOVER] paragraphs — by writing additional [VOICEOVER] paragraphs (2–4 sentences each) and supporting [ANIMATION NOTE] and [ON-SCREEN TEXT] lines. Do not rewrite existing content. Do not summarise. Only add new paragraphs to the thinnest Acts until the total reaches 2,250+ spoken words.\n\nSCRIPT:\n${script}\n\nContinue and expand now:`
    );
    if (!ext.error && ext.text) script = script.trimEnd() + '\n\n' + ext.text.trim();
  }

  setLoading(btn, '🗺️ Generate History Script', false);
  const voiceWordsFinal = script.split('\n')
    .filter(l => l.trim().startsWith('[VOICEOVER]'))
    .join(' ').split(/\s+/).filter(Boolean).length;
  const estMins = Math.round(voiceWordsFinal / 150);
  const outputHeader = get('history-output').querySelector('.ccp-output-label');
  if (outputHeader) outputHeader.textContent = `History Script — ${voiceWordsFinal.toLocaleString()} spoken words (~${estMins} min)`;

  const blocks = script.split(/\n\s*\n/).filter(b => b.trim());
  get('history-text').innerHTML = blocks.map(block => {
    const t = block.trim();
    if (/^###/.test(t)) return `<p style="margin:22px 0 6px;color:#c084fc;font-size:13px;font-weight:700;">${t.replace(/^###\s*/, '')}</p>`;
    if (/^\[VOICEOVER\]/i.test(t)) return `<p style="margin:0 0 10px;color:#e8ecf6;">${t}</p>`;
    if (/^\[ANIMATION NOTE\]/i.test(t)) return `<p style="margin:0 0 8px;color:#7c6fa0;font-size:11px;font-style:italic;">${t}</p>`;
    if (/^\[ON-SCREEN TEXT\]/i.test(t)) return `<p style="margin:0 0 8px;color:#14b8a6;font-size:11px;">${t}</p>`;
    if (/^\[AUDIO NOTE\]/i.test(t)) return `<p style="margin:0 0 8px;color:#f59e0b;font-size:11px;">${t}</p>`;
    if (/^\[TRANSITION\]/i.test(t)) return `<p style="margin:0 0 12px;color:#6b7280;font-size:11px;font-style:italic;">${t}</p>`;
    return `<p style="margin:0 0 10px;color:var(--text2);">${t.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  show('history-output');
  pushToRefiner('history-text');
  autosaveTab('history');
  markPipelineStep(currentNiche, 'script');
}

// ─── Map History Image Planner ────────────────────────────────────────────
async function generateHistoryImages() {
  const script = get('histimg-script').value.trim();
  const topic  = get('histimg-topic').value.trim() || 'this topic';
  if (!script) return showToast('Please paste your history script first.', 'error');

  const btn = get('generate-histimg-btn');
  setLoading(btn, '🖼 Generate Image Prompts');

  const SYS = `You are an expert storyboard artist and image prompt writer for cinematic map-style educational history videos (in the style of Vox, RealLifeLore, Kings and Generals). You convert completed scripts into detailed image generation prompts — one per [ANIMATION NOTE]. You always deliver the Frame Index Table first, then every frame in order, then the total frame count. You flag any frame that needs splitting into 2 keyframes.`;

  const prompt = `Convert the history script below into a sequence of image generation prompts for the topic: ${topic}

Generate one image prompt for EVERY [ANIMATION NOTE] in the script, in timestamp order.

---

OUTPUT FORMAT — use this structure for every frame:

**FRAME [NUMBER] — [TIMESTAMP] — [ACT NAME]**
> Prompt: [full image generation prompt]
> Overlay Text: [exact text from the nearest ON-SCREEN TEXT marker, or "None"]
> Transition Out: [from the nearest TRANSITION marker — cut / zoom / fade / wipe]
> Duration: [estimated seconds this frame is on screen]

---

UNIVERSAL STYLE RULES — apply to every prompt:

Base Aesthetic: cinematic illustrated map, aged parchment texture, editorial historical illustration. Art direction: flat but detailed, National Geographic maps meets motion graphics. Mood: authoritative, slightly dramatic, museum-quality. Aspect ratio: 16:9 widescreen.

Map Frames: base map texture aged cream/parchment with pale blue waterways. Territory colors — Subject nation: deep burgundy red (#6B0F1A). Rival/antagonist: cobalt blue (#003087). Invading force: dark forest green or antique gold. Colonial power: burnt orange. Allied/neutral: warm grey. All borders hand-drawn style, slightly imprecise like an antique atlas. Labels in serif typeface, aged ink style. Topography with subtle shading, not photorealistic.

Portrait Frames: detailed historical illustration, cutout with slight drop shadow, against map or soft vignette. Costume accuracy to era. Expression: neutral authority. Lighting: warm side-lit, like oil painting.

Battle/Conflict Frames: directional arrow overlays described in prompt. Clash icons (crossed swords) in illustrated style — never photographic. Arrow colors match territory color system.

Title Card Frames: dark vignette background (deep brown or near-black). Central serif title implied in prompt. Subtle map texture from edges. No photographic elements.

Icon/Infographic Frames: flat illustrated icons (coins, roads, ships, soldiers). Parchment background. Icons slightly 3D with gentle emboss. Colors match territory system.

PROMPT CONSTRUCTION — every prompt must include in order:
1. Shot type (wide map / medium portrait / close icon / title card / battle overview)
2. Subject (exactly who/what/where)
3. Action or state (what is happening or implied)
4. Era accuracy (specific century and region for costume/architecture)
5. Color palette (reference the color system explicitly)
6. Texture & style (parchment, aged ink, illustrated, cinematic)
7. Mood/lighting (dramatic side lighting / warm golden / cold tension / dark foreboding)
8. Exclusions ("no modern elements, no photography, no cartoonish simplification, no flat vector")

SPECIAL FRAME TYPES:
Timeline UI Frame: horizontal parchment banner across bottom third, divided into era segments, current era highlighted in burgundy, others in grey, illustrated scroll/ribbon style.
Territory Expansion Frame: describe before AND after states so animator knows both keyframes.
Montage Recap Frame: split into 4–6 panels, each showing one era's key visual, unified parchment texture, chronological left-to-right.

---

DELIVER:
1. Frame Index Table at the TOP: | Frame # | Timestamp | Act | Subject | Duration |
2. All image prompts in timestamp order
3. Total frame count at the end
4. Flag any frame too complex for a single still — suggest splitting into 2 keyframes

---

SCRIPT:
${script}

Begin with the Frame Index Table.`;

  const result = await callGemini(SYS, prompt);
  if (result.error) { setLoading(btn, '🖼 Generate Image Prompts', false); return showToast(result.error, 'error'); }

  setLoading(btn, '🖼 Generate Image Prompts', false);

  // Count frames
  const frameCount = (result.text.match(/\*\*FRAME\s+\d+/g) || []).length;
  const outputHeader = get('histimg-output').querySelector('.ccp-output-label');
  if (outputHeader) outputHeader.textContent = `Image Prompts — ${frameCount} frames`;

  // Render blocks
  const blocks = result.text.split(/\n\s*\n/).filter(b => b.trim());
  get('histimg-list').innerHTML = blocks.map(block => {
    const t = block.trim();

    // Frame header
    if (/^\*\*FRAME\s+\d+/i.test(t)) {
      return `<div style="background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.2);border-radius:10px;padding:14px 16px;margin-bottom:4px;">
        <div style="font-size:12px;font-weight:700;color:var(--accent-hi);margin-bottom:10px;">${t.replace(/\*\*/g,'')}</div>
      </div>`;
    }
    // Prompt / metadata lines
    if (/^>\s*(Prompt|Overlay|Transition|Duration):/i.test(t)) {
      const lines = t.split('\n').map(l => {
        const lm = l.trim().replace(/^>\s*/, '');
        const isPrompt = /^Prompt:/i.test(lm);
        const isOverlay = /^Overlay Text:/i.test(lm);
        const isTransition = /^Transition Out:/i.test(lm);
        const color = isPrompt ? 'var(--text2)' : isOverlay ? '#14b8a6' : isTransition ? '#6b7280' : '#f59e0b';
        return `<div style="font-size:11.5px;color:${color};line-height:1.7;margin-bottom:4px;">${lm}</div>`;
      }).join('');
      return `<div style="background:rgba(10,10,10,0.5);border:1px solid rgba(124,58,237,0.1);border-top:none;border-radius:0 0 10px 10px;padding:12px 16px;margin-bottom:12px;">${lines}</div>`;
    }
    // Table or other lines
    if (/^\|/.test(t)) {
      return `<div style="overflow-x:auto;margin-bottom:14px;"><table style="width:100%;border-collapse:collapse;font-size:11px;color:var(--text3);">${
        t.split('\n').map((row, i) => {
          if (/^[\|\-\s]+$/.test(row)) return '';
          const cells = row.split('|').filter(c => c.trim()).map(c => `<td style="padding:6px 10px;border:1px solid rgba(124,58,237,0.15);">${c.trim()}</td>`).join('');
          return i === 0 ? `<tr style="color:var(--accent-hi);">${cells}</tr>` : `<tr>${cells}</tr>`;
        }).join('')
      }</table></div>`;
    }
    return `<p style="font-size:12px;color:var(--text3);margin:0 0 10px;">${t.replace(/\n/g,'<br>')}</p>`;
  }).join('');

  show('histimg-output');
  markPipelineStep(currentNiche, 'images');
}

// ─── Geopolitical What-If Script Generator ───────────────────────────────
async function generateGeo() {
  const topic = get('geo-topic').value.trim();
  if (!topic) return showToast('Please enter a topic or scenario.', 'error');

  const btn = get('generate-geo-btn');
  setLoading(btn, '🌐 Generate Geopolitical Script');

  const SYS = `You are an expert geopolitical video scriptwriter specializing in fast-paced, analytical "what happens next" content in the style of Last Brain Cell, Wendover Productions, and RealLifeLore. You follow all formatting, length, and structural instructions with absolute precision. You always deliver the full Act Summary Table, complete script with all inline markers, and word count.`;

  const prompt = `Write a complete video script on the topic of: ${topic}

---

STRICT RULES — FOLLOW EXACTLY:

LENGTH & STRUCTURE:
- Total runtime: ~9–10 minutes (approx. 1,300–1,500 spoken words)
- Format: Hook Intro + 5–6 titled Acts + Conclusion with "Bigger Implications"
- Each Act = 1–2 minutes (150–250 spoken words + production notes)
- Acts must escalate in stakes: start local/immediate → zoom out to global consequences

SCRIPT FORMAT — USE THESE INLINE MARKERS EVERY TIME:
- [VOICEOVER] — the spoken narration line
- [ON-SCREEN TEXT] — any title card, label, stat, equation, or speech bubble
- [ANIMATION NOTE] — describe the stick figure / countryball / vector graphic action
- [TRANSITION] — how the scene cuts or slides to the next beat
- [AUDIO NOTE] — music mood shift or pacing note

---

WRITING VOICE RULES:
- Narrator tone: calm, analytical, slightly detached — like a war room briefer, not a pundit
- Sentences are punchy and declarative: "That matters." / "That's not nothing." / "And that's where things get expensive."
- Use contrast structures constantly: "Publicly X. Privately Y." / "Not X. Just Y." / "That's not victory. That's chaos."
- Every Act must open with a 1-sentence orientation line, then immediately introduce tension or stakes
- Include at least one concrete number or statistic per Act (%, $, barrels, miles, minutes, votes)
- Rhetorical questions allowed — max 2 per script, used only as Act openers
- Avoid emotional language — let the facts create the dread

---

INTRO (00:00 – ~00:20):
- Open mid-action — drop the viewer directly into the situation, no preamble
- State the central question the whole video will answer in 1–2 sentences
- End with a line that creates uncertainty: "And uncertainty is where [X] either collapses or spirals."

[ANIMATION NOTE] Simple opening graphic — key symbol or map of topic location
[ON-SCREEN TEXT] Topic name or operation name, large, center screen
[AUDIO NOTE] Low pulsing electronic/orchestral track begins — tense, no melody

---

ACT STRUCTURE (~00:20 – ~08:40):
Each Act must follow this internal structure:

### [ACT TITLE] — e.g. "Inside [X]" / "[Country]'s Angle" / "The Long [Cost]"

[ON-SCREEN TEXT] Act title card — center, large, handwritten/marker-style font
[VOICEOVER] 1-sentence scene-setter for this angle
[ANIMATION NOTE] Relevant countryball, stick figure, or map appears
[VOICEOVER] Core analysis — what's happening, what are the internal mechanics, what are the 2–3 possible paths or variables
[ANIMATION NOTE] Animate each path or variable — crossed-out text, bar charts, arrows, or dialogue bubbles
[ON-SCREEN TEXT] Key stat, label, or equation that visualizes the concept
[VOICEOVER] The twist — who benefits, who loses, what most people are missing
[ANIMATION NOTE] Countryball reaction, domino effect, or calculator showing "error"
[ON-SCREEN TEXT] Punchy summary phrase in a speech bubble or SMS text graphic
[TRANSITION] Fast cut or slide to next Act title card

---

REQUIRED ACTS — ADAPT TITLES TO THE TOPIC:

Act 1: Internal Dynamics of [Primary Actor] — 3 specific internal paths, each gets its own mini title card
Act 2: The Economic Reality / "The Long [Cost]" — concrete numbers, domestic political pain
Act 3: [Major Power #1]'s Angle — "Publicly X. Privately Y." structure, how they benefit from distraction
Act 4: [Major Power #2]'s Calculation — what gaps/opportunities appear while attention is elsewhere
Act 5: The Escalation Trap — miscalculation scenario, calculator showing "error", "No one officially wants that."
Act 6: The Most Likely Ending — realistic pressured outcome, back-channel diplomacy, each side "claims" something

---

CONCLUSION: BIGGER IMPLICATIONS (~08:40 – end):

[ON-SCREEN TEXT] "Bigger Implications" — title card
[VOICEOVER] Even if [topic] resolves, what doctrine or precedent does it set?
[ANIMATION NOTE] Globe spins, then domino effect across countries
[VOICEOVER] The chain reaction line — connect the topic to 3–4 global systems. Format: "[Topic] connects to [X]. [X] connects to [Y]. [Y] connects to [Z]. [Topic] isn't just a [regional] event. It's a stress test of the entire [system]."
[ANIMATION NOTE] Dominoes, bar charts turning into ballot boxes, puppet strings, globe with money strap
[ON-SCREEN TEXT] Outro card — "Thanks for watching!"

---

VISUAL STYLE (reference in all animation notes):
- Stick figures: black outline, minimal detail, expressive through pose only
- Countryballs: circular flags for nations, used for geopolitical actors
- Maps: flat vector, solid muted backgrounds (tan, grey, light blue)
- Danger/enemy/negative = RED (crossed-out items, arrows, X marks)
- Positive/deal/relief = GOLD or GREEN
- Neutral analysis = WHITE or GREY
- Font style: casual handwritten marker
- Graphics change every 2–4 seconds to match narration pace
- Background music: low-volume pulsing electronic drone, tense but not dramatic

---

DELIVER:
1. Act Summary Table at the TOP (Act name + timestamp range + one-line description)
2. Full script with all inline markers
3. Word count at the end

Begin immediately with the Act Summary Table.`;

  const r1 = await callGemini(SYS, prompt);
  if (r1.error) { setLoading(btn, '🌐 Generate Geopolitical Script', false); return showToast(r1.error, 'error'); }
  let script = r1.text;

  // Extend if short
  const voiceWords = script.split('\n').filter(l => l.trim().startsWith('[VOICEOVER]')).join(' ').split(/\s+/).filter(Boolean).length;
  if (voiceWords < 1100) {
    btn.textContent = `⏳ Extending… (${voiceWords} spoken words)`;
    const ext = await callGemini(SYS,
      `The script below has only ${voiceWords} spoken words in [VOICEOVER] lines. The target is 1,300–1,500. Expand the thinnest Acts by adding more [VOICEOVER], [ANIMATION NOTE], and [ON-SCREEN TEXT] lines. Do not rewrite. Only add to thin Acts.\n\nSCRIPT:\n${script}\n\nExpand now:`
    );
    if (!ext.error && ext.text) script = script.trimEnd() + '\n\n' + ext.text.trim();
  }

  setLoading(btn, '🌐 Generate Geopolitical Script', false);
  const totalWords = script.trim().split(/\s+/).length;
  const outputHeader = get('geo-output').querySelector('.ccp-output-label');
  if (outputHeader) outputHeader.textContent = `Geopolitical Script — ${totalWords.toLocaleString()} words`;

  const blocks = script.split(/\n\s*\n/).filter(b => b.trim());
  get('geo-text').innerHTML = blocks.map(block => {
    const t = block.trim();
    if (/^###/.test(t)) return `<p style="margin:22px 0 6px;color:#c084fc;font-size:13px;font-weight:700;">${t.replace(/^###\s*/,'')}</p>`;
    if (/^\[VOICEOVER\]/i.test(t)) return `<p style="margin:0 0 10px;color:#e8ecf6;">${t}</p>`;
    if (/^\[ANIMATION NOTE\]/i.test(t)) return `<p style="margin:0 0 8px;color:#7c6fa0;font-size:11px;font-style:italic;">${t}</p>`;
    if (/^\[ON-SCREEN TEXT\]/i.test(t)) return `<p style="margin:0 0 8px;color:#14b8a6;font-size:11px;">${t}</p>`;
    if (/^\[AUDIO NOTE\]/i.test(t)) return `<p style="margin:0 0 8px;color:#f59e0b;font-size:11px;">${t}</p>`;
    if (/^\[TRANSITION\]/i.test(t)) return `<p style="margin:0 0 12px;color:#6b7280;font-size:11px;font-style:italic;">${t}</p>`;
    if (/^\|/.test(t)) return `<div style="overflow-x:auto;margin-bottom:14px;"><table style="width:100%;border-collapse:collapse;font-size:11px;color:var(--text3);">${
      t.split('\n').map((row,i)=>{
        if(/^[\|\-\s]+$/.test(row))return'';
        const cells=row.split('|').filter(c=>c.trim()).map(c=>`<td style="padding:6px 10px;border:1px solid rgba(124,58,237,0.15);">${c.trim()}</td>`).join('');
        return i===0?`<tr style="color:var(--accent-hi);">${cells}</tr>`:`<tr>${cells}</tr>`;
      }).join('')
    }</table></div>`;
    return `<p style="margin:0 0 10px;color:var(--text2);">${t.replace(/\n/g,'<br>')}</p>`;
  }).join('');
  show('geo-output');
  pushToRefiner('geo-text');
  autosaveTab('geo');
  markPipelineStep(currentNiche, 'script');
}

// ─── Geopolitical Image Planner ──────────────────────────────────────────
async function generateGeoImages() {
  const script = get('geoimg-script').value.trim();
  const topic  = get('geoimg-topic').value.trim() || 'this topic';
  if (!script) return showToast('Please paste your geopolitical script first.', 'error');

  const btn = get('generate-geoimg-btn');
  setLoading(btn, '🖼 Generate Image Prompts');

  const SYS = `You are an expert storyboard artist and image prompt writer for fast-paced geopolitical explainer videos in the style of Last Brain Cell, Wendover Productions, and RealLifeLore. You convert completed scripts into detailed image generation prompts — one per [ANIMATION NOTE]. You always deliver the Frame Index Table first, then every frame in order, then total frame count. You flag any frame needing 2 keyframes.`;

  const prompt = `Convert the geopolitical script below into image generation prompts for: ${topic}

Generate one image prompt for EVERY [ANIMATION NOTE] in the script, in timestamp order.

---

OUTPUT FORMAT — use this structure for every frame:

**FRAME [NUMBER] — [TIMESTAMP] — [ACT NAME]**
> Prompt: [full image generation prompt]
> Overlay Text: [exact text from nearest ON-SCREEN TEXT marker, or "None"]
> Transition Out: [from nearest TRANSITION marker — fast cut / slide / dissolve]
> Duration: [estimated seconds — most frames are 2–4 seconds]

---

UNIVERSAL STYLE RULES — apply to every prompt:

Base Aesthetic: flat 2D digital illustration, whiteboard explainer meets editorial cartoon. Clean, minimal, slightly scrappy — intentionally lo-fi but sharp. Dry, analytical, slightly darkly comic. 16:9 widescreen. Background: solid muted flat color — tan (#D4C5A9), light grey (#E8E8E8), or pale blue (#C9DCE8) — never white, never gradient.

Stick Figure Rules: black outline only, no fill, no facial features except implied by posture. Expressive through body language: arms up = panic, slumped = defeated, thumbs up = approval, pointing = accusation. Add a small flag pin on chest or simple hat for national identity. Never photorealistic, never cartoonishly cute.

Countryball Rules: perfect circle with nation's flag texture, dot eyes, expressive through tilt and accessory only. Scale relative to power (larger = more powerful in context). Speech bubbles in casual handwritten font. Never 3D — flat with 1px dark outline.

Map Rules: flat vector style, no topography, no satellite texture. Muted solid colors per territory. Borders as clean 2px lines, slightly simplified. Key locations marked with simple pin icons. Labels bold sans-serif, all caps, minimal.

Color System (STRICT):
- Primary subject/actor: RED (#CC0000)
- Antagonist/rival: DARK RED or BLACK outline emphasis
- Outside major powers: standard flag colors, greyed 20%
- Danger zones/conflict areas: RED with pulsing ring implied
- Economic data/positive outcomes: GOLD (#FFB800) or GREEN (#2D8C3C)
- Neutral analysis: GREY (#9E9E9E)
- Crossed-out items: RED diagonal slash, thick stroke

Icon & Infographic Rules: flat single-color outline icons (oil barrel, dollar sign, missile, drone, ship, factory, ballot box, clock). Bar charts: hand-drawn style, slightly uneven bars, marker-style axes. Stats/equations: large bold handwritten font, center-weighted.

SPECIAL FRAME TYPES:
Title Card Frame: solid dark background (#1A1A1A), large centered handwritten marker-style title area (blank for overlay), subtle map texture at 10% opacity from edges.
Calculator "Error" Frame: chunky retro calculator, screen showing "ERROR" in red pixel font, slight crack, grey background.
Domino Effect Frame: top-down flat view of white dominoes falling in curved line across world map outline, each labeled with a system (Energy/Elections/Inflation/War), gold background.
"Publicly/Privately" Split Frame: frame divided vertically — left "PUBLICLY" with countryball giving thumbs up, right "PRIVATELY" with same countryball rubbing hands or holding chess piece.
SMS/Speech Bubble Frame: single SMS bubble centered on screen, bold handwritten text inside, solid muted background, no other elements.
Bar Chart Frame: hand-drawn style, slightly uneven bars, marker-style axes, bars colored per color system, bold all-caps labels, no grid lines.

PROMPT CONSTRUCTION — every prompt must include in order:
1. Frame type (stick figure scene / countryball scene / map shot / title card / infographic / icon beat)
2. Subject (exactly who/what is shown)
3. Action or state (posture, movement, interaction)
4. Setting (background color and any map/context)
5. Color references (explicitly name which color rules apply)
6. Font/text style (handwritten marker / bold sans-serif / SMS bubble)
7. Mood (dry tension / darkly comic / clinical / urgent)
8. Exclusions ("no photography, no 3D render, no gradients, no realistic faces, no detailed shading")

---

DELIVER:
1. Frame Index Table at TOP: | Frame # | Timestamp | Act | Subject | Duration |
2. All image prompts in timestamp order
3. Total frame count at end
4. Flag any frame needing 2 keyframes and explain why

---

SCRIPT:
${script}

Begin with the Frame Index Table.`;

  const result = await callGemini(SYS, prompt);
  if (result.error) { setLoading(btn, '🖼 Generate Image Prompts', false); return showToast(result.error, 'error'); }

  setLoading(btn, '🖼 Generate Image Prompts', false);
  const frameCount = (result.text.match(/\*\*FRAME\s+\d+/g) || []).length;
  const outputHeader = get('geoimg-output').querySelector('.ccp-output-label');
  if (outputHeader) outputHeader.textContent = `Image Prompts — ${frameCount} frames`;

  const blocks = result.text.split(/\n\s*\n/).filter(b => b.trim());
  get('geoimg-list').innerHTML = blocks.map(block => {
    const t = block.trim();
    if (/^\*\*FRAME\s+\d+/i.test(t)) {
      return `<div style="background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.2);border-radius:10px 10px 0 0;padding:12px 16px;margin-top:14px;margin-bottom:0;">
        <div style="font-size:12px;font-weight:700;color:var(--accent-hi);">${t.replace(/\*\*/g,'')}</div>
      </div>`;
    }
    if (/^>\s*(Prompt|Overlay|Transition|Duration):/i.test(t)) {
      const lines = t.split('\n').map(l => {
        const lm = l.trim().replace(/^>\s*/, '');
        const color = /^Prompt:/i.test(lm) ? 'var(--text2)' : /^Overlay/i.test(lm) ? '#14b8a6' : /^Transition/i.test(lm) ? '#6b7280' : '#f59e0b';
        return `<div style="font-size:11.5px;color:${color};line-height:1.7;margin-bottom:4px;">${lm}</div>`;
      }).join('');
      return `<div style="background:rgba(10,10,10,0.5);border:1px solid rgba(124,58,237,0.1);border-top:none;border-radius:0 0 10px 10px;padding:12px 16px;margin-bottom:0;">${lines}</div>`;
    }
    if (/^\|/.test(t)) {
      return `<div style="overflow-x:auto;margin-bottom:14px;"><table style="width:100%;border-collapse:collapse;font-size:11px;color:var(--text3);">${
        t.split('\n').map((row,i)=>{
          if(/^[\|\-\s]+$/.test(row))return'';
          const cells=row.split('|').filter(c=>c.trim()).map(c=>`<td style="padding:6px 10px;border:1px solid rgba(124,58,237,0.15);">${c.trim()}</td>`).join('');
          return i===0?`<tr style="color:var(--accent-hi);">${cells}</tr>`:`<tr>${cells}</tr>`;
        }).join('')
      }</table></div>`;
    }
    return `<p style="font-size:12px;color:var(--text3);margin:6px 0;">${t.replace(/\n/g,'<br>')}</p>`;
  }).join('');

  show('geoimg-output');
  markPipelineStep(currentNiche, 'images');
}

// ─── Script Refiner ───────────────────────────────────────────────────────
async function optimizeScript() {
  const script = get('script-input').value.trim();
  if (!script) return showToast('Please paste a script first.', 'error');

  const opts = [
    get('opt-tension').checked   && 'narrative tension — escalate dread gradually, make each section feel heavier than the last',
    get('opt-language').checked  && 'cinematic language — strengthen sensory detail, cut weak adjectives, make every sentence visual',
    get('opt-pov').checked       && 'second-person consistency — fix any drift to third-person, every sentence must address "you"',
    get('opt-ending').checked    && 'philosophical zoom-out — sharpen the final 2–4 sentences so they land like a door closing, not a speech'
  ].filter(Boolean).join('\n- ');

  if (!opts) return showToast('Select at least one refinement option.', 'error');

  const btn = get('optimize-script-btn');
  setLoading(btn, '🎙 Refine Script');

  const result = await callGemini(
    `You are a script editor specialising in historically grounded, second-person immersive YouTube narratives for stickman animation channels. You refine scripts without changing their structure or factual content. You only improve language, pacing, consistency, and emotional impact.`,
    `Refine this script. Apply the following improvements:
- ${opts}

Rules:
- Do NOT change the 8-part structure.
- Do NOT add or remove historical facts.
- Do NOT add jokes, levity, or modern slang.
- Do NOT change the ending type.
- REMOVE every [VISUAL:] and [MUSIC:] cue entirely. Do not replace them with anything.
- REMOVE all section headers (PART 1, PART 2, etc.). Do not replace them with anything.
- Output must be pure narration only — no brackets, no labels, no directives of any kind.
- Return ONLY the clean narration. No preamble, no explanation.

Script:
${script}`
  );

  setLoading(btn, '🎙 Refine Script', false);
  if (result.error) return showToast(result.error, 'error');
  get('script-text').textContent = result.text;
  show('script-output');
  autosaveTab('script');
  markPipelineStep(currentNiche, 'refiner');
}

// ─── Image Planner ────────────────────────────────────────────────────────
function resetImagePlanner() {
  _anchorImgData = null;
  _anchorImgMime = null;
  _secondaryAnchors = {};

  get('image-style').value = '';

  const anchorOptions = get('anchor-options');
  anchorOptions.style.display = 'none';
  anchorOptions.innerHTML = '';

  get('character-anchor').value = '';

  const scriptArea = get('image-script');
  scriptArea.value = '';
  scriptArea.disabled = true;
  scriptArea.style.opacity = '0.4';
  scriptArea.style.cursor = 'not-allowed';
  scriptArea.style.resize = 'none';
  scriptArea.placeholder = 'Select a character look above first…';

  const planBtn = get('plan-images-btn');
  planBtn.disabled = true;
  planBtn.style.opacity = '0.4';
  planBtn.style.cursor = 'not-allowed';
  planBtn.textContent = '🖼 Plan Visual Beats';

  get('image-beats-list').innerHTML = '';
  get('images-output').style.display = 'none';

  _styleReferencePrompt = '';
  get('style-reference-url').value = '';
  get('style-ref-text').textContent = '';
  get('style-ref-preview').style.display = 'none';

  showToast('Planner reset.', 'success');
}

async function extractStyleReference() {
  const url = get('style-reference-url').value.trim();
  if (!url) return showToast('Paste a URL first.', 'error');
  if (!hasApiAccess()) return showToast('Add your Gemini API key in ⚙️ Settings.', 'error');

  const btn = get('extract-style-ref-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Scanning…';

  const SYS = 'You are a forensic visual analyst. You describe visual styles with obsessive, technical precision so that an AI image generator can reproduce them exactly from your description alone — even if the source material is a crude stickman drawing.';
  const USER = `Analyse this reference with forensic precision. Your job is to write a style description so technically specific that an AI image generator could reproduce it exactly without ever seeing the original.

Cover ALL of the following — do not skip any, even if the answer seems trivially simple (e.g. "no shading at all"):

1. FIGURE CONSTRUCTION: Describe exactly how figures/characters are built. Are heads circles, ovals, squares? Are limbs single lines, tubes, or shapes with fill? Are joints visible or absent? Are proportions realistic, chibi, elongated, or stick-like? Approximate head-to-body ratio.

2. LINE WORK: Exact stroke style — single-pixel hairlines, thick uniform outlines, tapered brush strokes, or no outlines at all? Are lines perfectly straight/geometric or hand-drawn and wobbly? Stroke weight in relative terms (hairline / thin / medium / thick / very thick).

3. COLOUR PALETTE: Name every dominant colour. Use specific descriptors or approximate hex values where possible (e.g. "flat #FF4500 orange-red", "muted dusty rose", "pure #FFFFFF white with no tint"). State whether colours are flat/solid, gradient-filled, or textured. How many colours total are used?

4. BACKGROUND: Is it solid colour, gradient, detailed scene, or absent (transparent/white)? Describe the background construction method — are backgrounds drawn with the same line weight as foreground, or are they simpler/more detailed?

5. SHADING & DEPTH: Is there zero shading (pure flat), cel-shading (hard shadow shapes), soft gradients, or full photorealistic lighting? If shadows exist, describe their colour and hardness. Does the art feel 2D flat or does it imply 3D depth?

6. TEXTURE & SURFACE: Is the surface clean and digital, grainy/noisy, painterly, watercolour-washed, rough/sketchy, or perfectly smooth vector?

7. SCALE & COMPOSITION: How large do figures appear relative to the frame? Are scenes sparse or densely detailed?

8. OVERALL STYLE LABEL: Give the most accurate style label possible — e.g. "MS Paint stick figure", "Flash animation flat vector", "children's crayon illustration", "woodblock print", "pixel art 16-bit", "3D low-poly", etc.

Output a single dense paragraph (6–10 sentences) combining all of the above into a reusable style prompt. Be ruthlessly specific. Never use vague words like "cinematic", "beautiful", or "stylistic" without qualification. Output the paragraph only — no headers, no bullet points, no labels.`;

  let result;
  const isYouTube = /youtube\.com|youtu\.be/.test(url);

  if (isYouTube) {
    result = await callGeminiWithVideo(url, SYS, USER);
  } else {
    try {
      const fetchResp = await fetch(url);
      if (!fetchResp.ok) throw new Error(`HTTP ${fetchResp.status}`);
      const blob = await fetchResp.blob();
      const mimeType = blob.type || 'image/jpeg';
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(',')[1]);
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
      const apiResp = await _geminiFetch('gemini-2.5-flash', {
          system_instruction: { parts: [{ text: SYS }] },
          contents: [{ parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: USER }
          ]}],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.3 }
        });
      if (!apiResp.ok) {
        const err = await apiResp.json().catch(() => ({}));
        result = { error: err?.error?.message || `HTTP ${apiResp.status}` };
      } else {
        const data = await apiResp.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
        result = text ? { text } : { error: `No text in response. Raw: ${JSON.stringify(data).slice(0, 300)}` };
      }
    } catch (e) {
      result = { error: e.message };
    }
  }

  btn.disabled = false;
  btn.textContent = '🔍 Extract Style';
  if (result.error) return showToast(result.error, 'error');

  _styleReferencePrompt = result.text.trim();
  get('style-ref-text').textContent = _styleReferencePrompt;
  get('style-ref-preview').style.display = 'block';
  showToast('Style locked! All image prompts will use this style.', 'success');
}

function clearStyleReference() {
  _styleReferencePrompt = '';
  get('style-reference-url').value = '';
  get('style-ref-text').textContent = '';
  get('style-ref-preview').style.display = 'none';
  showToast('Style reference cleared.', 'success');
}

async function extractStyleReferenceOther() {
  if (!hasApiAccess()) return showToast('Add your Gemini API key in ⚙️ Settings.', 'error');

  const fileInput = get('style-reference-file-other');
  const url       = get('style-reference-url-other').value.trim();
  const file      = fileInput.files?.[0];

  if (!file && !url) return showToast('Upload an image or paste a URL first.', 'error');

  const btn = get('extract-style-ref-other-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Scanning…';

  const SYS = 'You are a forensic visual analyst. You describe visual styles with obsessive, technical precision so that an AI image generator can reproduce them exactly from your description alone — even if the source material is a crude stickman drawing.';
  const USER = `Analyse this reference with forensic precision. Your job is to write a style description so technically specific that an AI image generator could reproduce it exactly without ever seeing the original.

Cover ALL of the following — do not skip any, even if the answer seems trivially simple (e.g. "no shading at all"):

1. FIGURE CONSTRUCTION: Describe exactly how figures/characters are built. Are heads circles, ovals, squares? Are limbs single lines, tubes, or shapes with fill? Are joints visible or absent? Are proportions realistic, chibi, elongated, or stick-like? Approximate head-to-body ratio.

2. LINE WORK: Exact stroke style — single-pixel hairlines, thick uniform outlines, tapered brush strokes, or no outlines at all? Are lines perfectly straight/geometric or hand-drawn and wobbly? Stroke weight in relative terms (hairline / thin / medium / thick / very thick).

3. COLOUR PALETTE: Name every dominant colour. Use specific descriptors or approximate hex values where possible (e.g. "flat #FF4500 orange-red", "muted dusty rose", "pure #FFFFFF white with no tint"). State whether colours are flat/solid, gradient-filled, or textured. How many colours total are used?

4. BACKGROUND: Is it solid colour, gradient, detailed scene, or absent (transparent/white)? Describe the background construction method — are backgrounds drawn with the same line weight as foreground, or are they simpler/more detailed?

5. SHADING & DEPTH: Is there zero shading (pure flat), cel-shading (hard shadow shapes), soft gradients, or full photorealistic lighting? If shadows exist, describe their colour and hardness. Does the art feel 2D flat or does it imply 3D depth?

6. TEXTURE & SURFACE: Is the surface clean and digital, grainy/noisy, painterly, watercolour-washed, rough/sketchy, or perfectly smooth vector?

7. SCALE & COMPOSITION: How large do figures appear relative to the frame? Are scenes sparse or densely detailed?

8. OVERALL STYLE LABEL: Give the most accurate style label possible — e.g. "MS Paint stick figure", "Flash animation flat vector", "children's crayon illustration", "woodblock print", "pixel art 16-bit", "3D low-poly", etc.

Output a single dense paragraph (6–10 sentences) combining all of the above into a reusable style prompt. Be ruthlessly specific. Never use vague words like "cinematic", "beautiful", or "stylistic" without qualification. Output the paragraph only — no headers, no bullet points, no labels.`;

  const _geminiImageCall = async (base64, mimeType) => {
    const apiResp = await _geminiFetch('gemini-2.5-flash', {
        system_instruction: { parts: [{ text: SYS }] },
        contents: [{ parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: USER }
        ]}],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.3 }
      });
    if (!apiResp.ok) {
      const err = await apiResp.json().catch(() => ({}));
      return { error: err?.error?.message || `HTTP ${apiResp.status}` };
    }
    const data = await apiResp.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!text) return { error: `No text in response. Raw: ${JSON.stringify(data).slice(0, 300)}` };
    return { text };
  };

  let result;

  if (file) {
    // File upload path — read directly from disk, no fetch needed
    try {
      const mimeType = file.type || 'image/jpeg';
      const base64   = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(',')[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      // Store the raw image so Gemini can SEE it during prompt generation and rendering
      _styleRefImgData = base64;
      _styleRefImgMime = mimeType;
      result = await _geminiImageCall(base64, mimeType);
    } catch (e) {
      result = { error: e.message };
    }
  } else if (/youtube\.com|youtu\.be/.test(url)) {
    result = await callGeminiWithVideo(url, SYS, USER);
  } else {
    // Remote image URL — fetch then send as inline data
    try {
      const fetchResp = await fetch(url);
      if (!fetchResp.ok) throw new Error(`HTTP ${fetchResp.status}`);
      const blob     = await fetchResp.blob();
      const mimeType = blob.type || 'image/jpeg';
      const base64   = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(',')[1]);
        reader.onerror = rej;
        reader.readAsDataURL(blob);
      });
      result = await _geminiImageCall(base64, mimeType);
    } catch (e) {
      result = { error: e.message };
    }
  }

  btn.disabled = false;
  btn.textContent = '🔍 Extract Style';
  if (result.error) return showToast(result.error, 'error');

  _styleReferencePromptOther = result.text.trim();
  get('style-ref-text-other').textContent = _styleReferencePromptOther;
  get('style-ref-preview-other').style.display = 'block';
  // Clear the URL field when an image was uploaded — compiler will use the image instead
  if (file) get('style-reference-url-other').value = '';
  showToast('Style locked! All image prompts will use this style.', 'success');
}

function clearStyleReferenceOther() {
  _styleReferencePromptOther = '';
  _styleRefImgData = null;
  _styleRefImgMime = null;
  get('style-reference-url-other').value = '';
  get('style-reference-file-other').value = '';
  get('style-file-name-other').textContent = 'Click to upload a reference image…';
  get('style-ref-text-other').textContent = '';
  get('style-ref-preview-other').style.display = 'none';
  showToast('Style reference cleared.', 'success');
}

async function suggestCharacterLooks() {
  const style = getActiveImageStyle();
  if (!style) return showToast('Select a visual style first.', 'error');

  const role    = get('prompt-role').value.trim();
  const setting = get('prompt-setting').value.trim();

  const contextBlock = role
    ? `ROLE: ${role}\nSETTING: ${setting || 'unspecified'}`
    : `Generate looks for a general historical narrative subject.`;

  const btn = get('suggest-anchor-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Generating looks…';

  const result = await callGemini(
    `You are a character designer for animated YouTube videos. You create vivid, consistent visual descriptions of main characters that can be used as locked reference anchors for AI image generators.`,
    `Based on the following context, generate exactly 3 distinct character appearance options for the main subject.

${contextBlock}

VISUAL STYLE: ${style}
The character descriptions must be written so they translate accurately into this visual style.

Rules:
- Each option must depict the character at exactly 18 years old — smooth skin, no lines, full hair, youthful jaw.
- Each option must be a single paragraph of 40–60 words.
- Focus PRIMARILY on facial features: face shape, skin tone, eye shape and colour, brow line, nose, jawline, hair style and colour.
- Also include body build (lean/broad/stocky) and one era-appropriate clothing detail.
- Do NOT use words like "aged", "weathered", "wrinkled", "worn face", "old", "mature", "middle-aged".
- Each option must be visually distinct through facial structure and build only.
- No names. No backstory. Pure visual description only.
- Write ONLY the 3 options in this exact format:

OPTION 1
[description]

OPTION 2
[description]

OPTION 3
[description]`
  );

  btn.disabled = false;
  btn.textContent = '✨ Suggest 3 Looks';

  if (result.error) return showToast(result.error, 'error');

  const options = [];
  const blocks = result.text.split(/\bOPTION\s+\d+\b/i).map(s => s.trim()).filter(Boolean);
  for (const block of blocks) {
    if (block) options.push(block);
  }

  if (!options.length) return showToast('Could not parse options. Try again.', 'error');

  const container = get('anchor-options');
  container.style.display = 'block';
  container.innerHTML = '';

  const renderBtn = document.createElement('button');
  renderBtn.id = 'anchor-render-btn';
  renderBtn.className = 'ccp-btn';
  renderBtn.disabled = true;
  renderBtn.textContent = '🎨 Render Reference Image';
  renderBtn.style.cssText = 'width:100%;margin-top:4px;background:#1e293b;color:#475569;border:1px solid #1e293b;font-size:11px;';

  const preview = document.createElement('div');
  preview.id = 'anchor-render-preview';

  options.forEach((desc, i) => {
    const card = document.createElement('div');
    card.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;font-size:11px;color:#94a3b8;line-height:1.6;';
    card.innerHTML = `<strong style="color:#e2e8f0;font-size:10px;letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:4px;">Look ${i + 1}</strong>${escapeHTML(desc)}`;

    card.addEventListener('mouseenter', () => {
      if (!card._selected) { card.style.borderColor = '#6366f1'; card.style.color = '#e2e8f0'; }
    });
    card.addEventListener('mouseleave', () => {
      if (!card._selected) { card.style.borderColor = '#334155'; card.style.color = '#94a3b8'; }
    });
    card.addEventListener('click', () => {
      get('character-anchor').value = desc;
      _anchorImgData = null;
      _anchorImgMime = null;
      preview.innerHTML = '';

      container.querySelectorAll('div[data-look]').forEach(c => {
        c._selected = false;
        c.style.borderColor = '#334155';
        c.style.background  = '#1e293b';
        c.style.color       = '#94a3b8';
      });
      card._selected = true;
      card.style.borderColor = '#6366f1';
      card.style.background  = '#1e1b4b';
      card.style.color       = '#e2e8f0';

      renderBtn.disabled = false;
      renderBtn.style.color = '#94a3b8';
      renderBtn.style.borderColor = '#334155';
      renderBtn.style.background = '#1e293b';
      renderBtn.onclick = () => renderAnchorReference();

      showToast('Look selected — render the reference image to continue.', 'success');
    });

    card.dataset.look = i;
    container.appendChild(card);
  });

  container.appendChild(renderBtn);
  container.appendChild(preview);
}

async function renderAnchorReference() {
  const anchor = get('character-anchor').value.trim();
  if (!anchor) return;

  if (!hasApiAccess()) return showToast('Add your Gemini API key in ⚙️ Settings.', 'error');

  const container = get('anchor-options');
  const btn = container.querySelector('#anchor-render-btn');
  const preview = container.querySelector('#anchor-render-preview');

  btn.disabled = true;
  btn.textContent = '⏳ Rendering reference…';

  const style = getActiveImageStyle();
  const prompt = `Front-facing character reference sheet, neutral plain background, ${style} style. Render this character at exactly 18 years old — smooth skin, no wrinkles, full hair, sharp youthful jaw. Character: ${anchor}. Show the face prominently and clearly. No background details. CRITICAL: No solid black body — body must show skin tone or clothing colour.`;

  const result = await nanoBananaRender({ prompt });

  btn.disabled = false;
  btn.textContent = '🎨 Re-render Reference';

  if (result.error) {
    preview.innerHTML = `<p style="color:#ef4444;font-size:11px;margin-top:6px;">❌ ${escapeHTML(result.error)}</p>`;
    return;
  }

  _anchorImgData = result.imageData;
  _anchorImgMime = result.mimeType;

  const dataUrl = `data:${result.mimeType};base64,${result.imageData}`;
  preview.innerHTML = `
    <img src="${dataUrl}" style="width:100%;border-radius:6px;margin-top:6px;border:2px solid #6366f1;" alt="Character reference" />
    <p style="font-size:10px;color:#6366f1;margin:4px 0 0;text-align:center;">✅ Reference locked — now paste your script below</p>`;

  const scriptArea = get('image-script');
  scriptArea.disabled = false;
  scriptArea.style.opacity = '';
  scriptArea.style.cursor = '';
  scriptArea.style.resize = '';
  scriptArea.placeholder = 'Paste your script or story...';

  const planBtn = get('plan-images-btn');
  planBtn.disabled = false;
  planBtn.style.opacity = '';
  planBtn.style.cursor = '';

  showToast('Reference locked — paste your script to continue.', 'success');
}

async function planImages() {
  if (!get('character-anchor').value.trim()) return showToast('Select a character look first.', 'error');
  const script = get('image-script').value.trim();
  if (!script) return showToast('Please paste a script or story.', 'error');

  const totalCount = Number(get('image-count').value);
  const style = getActiveImageStyle();
  const btn = get('plan-images-btn');
  const userAnchor = get('character-anchor').value.trim();

  const SYSTEM = `You are a visual storyteller and AI image prompt engineer. You split scripts into perfect visual sequences with strict character consistency across every image.`;

  btn.disabled = true;
  btn.textContent = '⏳ Analysing characters…';

  const charResult = await callGemini(
    `You are a character designer. You read scripts and identify all recurring secondary characters.`,
    `Read this script and list every secondary character (not the main protagonist) who appears in more than one scene or moment.

Script:
${script}

For each recurring secondary character, assign a locked 15-25 word visual description covering: apparent age range, face/hair features, and one era-appropriate clothing detail.

Output format:
SECONDARY CHARACTERS:
[role label e.g. "the mother"]: [visual description]

If no recurring secondary characters exist, output exactly: NONE`
  );

  const rawSecondaryText = (!charResult.error && charResult.text.trim().toUpperCase() !== 'NONE')
    ? charResult.text.replace(/^SECONDARY CHARACTERS:\s*/i, '').trim()
    : '';

  const secondaryBlock = rawSecondaryText
    ? `\nSECONDARY CHARACTER ANCHORS — whenever these characters appear in an IMAGE prompt, identify them by role label first then use their locked visual description:\n${rawSecondaryText}`
    : '';

  _secondaryAnchors = {};
  if (rawSecondaryText && getGeminiKey()) {
    const charEntries = rawSecondaryText.split('\n')
      .map(line => { const m = line.match(/^(.+?):\s*(.+)$/); return m ? { role: m[1].trim().toLowerCase(), desc: m[2].trim() } : null; })
      .filter(Boolean);

    for (let ci = 0; ci < charEntries.length; ci++) {
      const { role, desc } = charEntries[ci];
      btn.textContent = `⏳ Rendering character refs (${ci + 1}/${charEntries.length})…`;
      const refPrompt = `Front-facing character reference sheet, neutral plain background, ${style} style. Character: ${desc}. Show the face prominently and clearly. No background details. CRITICAL: No solid black body.`;
      const refResult = await nanoBananaRender({ prompt: refPrompt });
      if (!refResult.error) _secondaryAnchors[role] = { data: refResult.imageData, mime: refResult.mimeType };
    }
  }

  const anchorInstruction = userAnchor
    ? `LOCKED CHARACTER DESCRIPTION — use this exact appearance in every IMAGE prompt without deviation:
"${userAnchor}"
This is the main character anchor. Start every IMAGE prompt with a version of this description, then describe the scene around them.`
    : `CHARACTER ANCHOR — infer the main character's appearance from the script and keep it identical across all images.`;

  const consistencyRules = `${anchorInstruction}
${secondaryBlock}

CHARACTER CONSISTENCY RULES — apply to every single IMAGE prompt without exception:
- The main character must look identical across all images: same face structure, same skin tone, same body proportions.
- The only permitted changes are natural aging progressions tied to the script's timeline.
- Never change defining physical traits (face shape, eye colour, hair colour unless greying with age, ethnicity).
- Minor context-driven alterations allowed: torn/dirty clothing, wounds, exhaustion, shackles — but the face must remain the same person.
- CRITICAL LABELLING RULE: In every IMAGE prompt, always refer to the protagonist as "the main character" — NEVER by their story role.
- STYLE LOCK: Every IMAGE prompt must stay strictly within the ${_styleReferencePrompt ? `following reference style: ${_styleReferencePrompt}` : `${style} visual style`}.
- BODY COLOUR RULE — MANDATORY: Human figures and stick figures must NEVER have solid black filled bodies. Bodies must be rendered with skin tone, clothing colour, or coloured/white line-art. A solid black silhouette body is strictly forbidden.`;

  const makePrompt = (from, to) =>
    `Split this script into exactly ${totalCount} visual beats total, then output ONLY beats ${from} to ${to} (prompts numbered ${from}–${to}).

Visual style: ${_styleReferencePrompt ? `Strictly match this reference: ${_styleReferencePrompt}` : style}

Script:
${script}

${consistencyRules}

Output format — follow this exactly, blank line between each block:

PROMPT ${from}
SCRIPT: [exact script lines this beat covers]
IMAGE: [60-80 word prompt in plain English matching ${_styleReferencePrompt ? 'the reference style above exactly' : `${style} style`}. Start with the main character anchor. Always call the protagonist "the main character". Do not change art style.]

...continue up to PROMPT ${to}.

Rules:
- No JSON. No extra headers beyond PROMPT N, SCRIPT:, IMAGE:.
- SCRIPT: must be a direct quote, not a summary.
- IMAGE: plain descriptive English, no brackets, no placeholders.
- Start immediately with PROMPT ${from}.`;

  const half = Math.ceil(totalCount / 2);
  const batches = [
    { from: 1,        to: half },
    { from: half + 1, to: totalCount },
  ];

  let combinedText = '';

  for (let i = 0; i < batches.length; i++) {
    const { from, to } = batches[i];
    btn.disabled = true;
    btn.textContent = `⏳ Batch ${i + 1} of 2 (prompts ${from}–${to})…`;

    const result = await callGemini(SYSTEM, makePrompt(from, to));

    if (result.error) {
      setLoading(btn, '🖼 Plan Visual Beats', false);
      return showToast(result.error, 'error');
    }
    combinedText += (combinedText ? '\n\n' : '') + result.text.trim();
  }

  setLoading(btn, '🖼 Plan Visual Beats', false);
  renderBeatsPlainText(combinedText);
  saveBeatData(currentNiche);
  show('images-output');
  autosaveTab('images');
  markPipelineStep(currentNiche, 'images');
}

function renderBeatsPlainText(text) {
  const blocks = text.trim().split(/\n\s*(?=PROMPT\s+\d+)/i).filter(s => s.trim());
  get('image-beats-list').innerHTML = blocks.map(block => {
    const lines = block.trim().split('\n');
    const label = lines[0].trim();

    let scriptLine = '';
    let imageLine  = '';
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (/^SCRIPT:\s*/i.test(t))      scriptLine = t.replace(/^SCRIPT:\s*/i, '');
      else if (/^IMAGE:\s*/i.test(t))  imageLine  = t.replace(/^IMAGE:\s*/i, '');
      else if (scriptLine && !imageLine) scriptLine += ' ' + t;
      else if (imageLine) imageLine += ' ' + t;
    }

    return `
      <div class="beat-item">
        <div class="beat-header">
          <span class="beat-num">${escapeHTML(label)}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <button class="beat-render-btn" title="Render with Nano Banana">🎨 Render</button>
            <button class="beat-copy-btn" title="Copy image prompt">📋</button>
          </div>
        </div>
        ${scriptLine ? `<div class="beat-script-line">${escapeHTML(scriptLine)}</div>` : ''}
        <div class="beat-prompt-block">
          <div class="beat-prompt">${escapeHTML(imageLine || lines.slice(1).join(' ').trim())}</div>
        </div>
      </div>`;
  }).join('');
}

function saveBeatData(niche) {
  if (!niche) return;
  const items = document.querySelectorAll('.beat-item');
  const beats = Array.from(items).map((el, i) => ({
    num:        i + 1,
    label:      el.querySelector('.beat-num')?.textContent?.trim() || `Beat ${i + 1}`,
    scriptLine: el.querySelector('.beat-script-line')?.textContent?.trim() || '',
  }));
  try { localStorage.setItem(`beatData_${niche}`, JSON.stringify(beats)); } catch(e) {}
}

function getBeatData(niche) {
  try { return JSON.parse(localStorage.getItem(`beatData_${niche}`) || '[]'); } catch { return []; }
}

function saveBeatImages(niche) {
  if (!niche) return;
  const items = document.querySelectorAll('.beat-item');
  const images = {};
  items.forEach((el, i) => {
    const img = el.querySelector('.beat-image');
    if (img && img.src && img.src.startsWith('data:')) {
      const comma = img.src.indexOf(',');
      const mime = img.src.slice(5, img.src.indexOf(';')) || 'image/png';
      images[i + 1] = { data: img.src.slice(comma + 1), mime };
    }
  });
  try { localStorage.setItem(`beatImages_${niche}`, JSON.stringify(images)); } catch(e) {}
}

function getBeatImages(niche) {
  try { return JSON.parse(localStorage.getItem(`beatImages_${niche}`) || '{}'); } catch { return {}; }
}

function saveVeo3Prompts(niche) {
  if (!niche) return;
  const items = document.querySelectorAll('.veo3-item');
  const prompts = Array.from(items).map((el, i) => ({
    num: i + 1,
    text: el.querySelector('.veo3-prompt')?.textContent?.trim() || ''
  }));
  try { localStorage.setItem(`veo3Prompts_${niche}`, JSON.stringify(prompts)); } catch(e) {}
}

function getVeo3Prompts(niche) {
  try { return JSON.parse(localStorage.getItem(`veo3Prompts_${niche}`) || '[]'); } catch { return []; }
}

function copyAllBeats() {
  const items = document.querySelectorAll('.beat-item');
  if (!items.length) return;
  const prompts = Array.from(items).map((el, i) => {
    const prompt = el.querySelector('.beat-prompt')?.textContent || '';
    return `Image ${i + 1}:\n${prompt}`;
  }).join('\n\n');
  copyText(prompts);
}

async function renderBeatImage(btn) {
  const item = btn.closest('.beat-item');
  const prompt = item.querySelector('.beat-prompt')?.textContent?.trim();
  if (!prompt) return;

  if (!hasApiAccess()) return showToast('Add your Gemini API key in ⚙️ Settings.', 'error');

  const style = getActiveImageStyle();

  const refImages = [];
  const refLabels = [];

  // Style reference image goes in FIRST so the model sees it before character refs
  if (_styleRefImgData && _styleRefImgMime) {
    refImages.push({ data: _styleRefImgData, mime: _styleRefImgMime });
    refLabels.push('STYLE REFERENCE');
  }

  if (_anchorImgData && _anchorImgMime) {
    refImages.push({ data: _anchorImgData, mime: _anchorImgMime });
    refLabels.push('the main character');
  }

  for (const [role, anchor] of Object.entries(_secondaryAnchors)) {
    if (prompt.toLowerCase().includes(role.toLowerCase())) {
      refImages.push({ data: anchor.data, mime: anchor.mime });
      refLabels.push(role);
    }
  }

  let refInstruction = '';
  if (refImages.length > 0) {
    const imageList = refLabels.map((label, i) => {
      if (label === 'STYLE REFERENCE') {
        return `- Attached image ${i + 1}: STYLE REFERENCE — replicate this exact art style, colour palette, rendering technique, lighting, and mood in every detail of the generated image`;
      }
      return `- Attached image ${i + 1}: ${label.toUpperCase()} — use this exact face for whoever is referred to as "${label}" in the scene below`;
    }).join('\n');
    refInstruction = `REFERENCE IMAGES PROVIDED:\n${imageList}\n\n`;
  }

  const noBlackBody = `CRITICAL: No character or figure may have a solid black body — bodies must show skin tone, clothing colour, or visible line-art. A silhouette-style solid black body is forbidden.`;

  const _recBaseMatch = currentOtherVisualStyleGuide
    ? currentOtherVisualStyleGuide.match(/RECREATION PROMPT BASE[:\s]+(.+)/i)
    : null;
  const _recBase = _recBaseMatch ? _recBaseMatch[1].trim() : null;

  const styleLock = _styleRefImgData
    ? `STYLE LOCK — the first attached image is your STYLE REFERENCE. Replicate its exact art style, colour palette, rendering technique, line weight, lighting, and mood across every pixel of the generated image. Do not deviate from this style under any circumstances.`
    : _styleReferencePrompt
      ? `STYLE LOCK — replicate this exact visual style across every detail of the image: ${_styleReferencePrompt} Do not deviate from this style under any circumstances.`
      : _recBase
        ? `STYLE LOCK — you are replicating the exact visual style of the reference video. ${_recBase}. Do not deviate from this style under any circumstances.`
        : `STYLE LOCK: Render this image strictly in ${style} style. Do not deviate from this art style.`;

  const fullPrompt = refImages.length > 0
    ? `${styleLock} ${noBlackBody}\n\n${refInstruction}Each character in the scene must use the face from their corresponding reference image. Secondary characters must remain visually distinct.\n\nRender this scene:\n${prompt}`
    : `${styleLock} ${noBlackBody}\n\n${prompt}`;

  btn.disabled = true;
  btn.textContent = '⏳ Rendering…';
  item.querySelector('.beat-image-wrap')?.remove();

  const result = await nanoBananaRender({
    prompt: fullPrompt,
    referenceImages: refImages.length > 0 ? refImages : undefined
  });

  btn.disabled = false;
  btn.textContent = '🎨 Render';

  const wrap = document.createElement('div');
  wrap.className = 'beat-image-wrap';

  if (result.error) {
    wrap.innerHTML = `<div class="beat-render-error">❌ ${escapeHTML(result.error)}</div>`;
    item.appendChild(wrap);
    return;
  }

  const dataUrl = `data:${result.mimeType};base64,${result.imageData}`;
  const ext = result.mimeType.split('/')[1] || 'png';
  wrap.innerHTML = `
    <img src="${dataUrl}" class="beat-image" alt="Generated image" />
    <div class="beat-img-actions">
      <a class="beat-img-download" href="${dataUrl}" download="prompt-${Date.now()}.${ext}">⬇ Download</a>
      <button class="beat-rerender-btn">🔄 Render Again</button>
    </div>
  `;
  item.appendChild(wrap);
  if (!result.error) saveBeatImages(currentNiche);
}

async function renderAllBeats() {
  const pending = Array.from(document.querySelectorAll('.beat-item')).filter(
    item => !item.querySelector('.beat-image-wrap')
  );
  if (!pending.length) return showToast('No unrendered beats found.', 'error');

  const btn1 = get('render-all-beats-btn');
  const btn2 = get('render-all-otherimg-btn');
  const total = pending.length;

  const setLabel = (i) => {
    const label = `⏳ Rendering ${i}/${total}…`;
    if (btn1) { btn1.disabled = true; btn1.textContent = label; }
    if (btn2) { btn2.disabled = true; btn2.textContent = label; }
  };

  setLabel(0);

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const renderBtn = item.querySelector('.beat-render-btn');
    if (!renderBtn) continue;

    setLabel(i + 1);
    showToast(`Rendering beat ${i + 1} of ${total}…`);

    try {
      await renderBeatImage(renderBtn);
    } catch (err) {
      console.error(`renderAllBeats: beat ${i + 1} failed`, err);
    }
  }

  if (btn1) { btn1.disabled = false; btn1.textContent = '🎨 Render All'; }
  if (btn2) { btn2.disabled = false; btn2.textContent = '🎨 Render All'; }
  showToast('✅ All beats rendered', 'success');
}

// ─── Video Assembly ───────────────────────────────────────────────────────
function populateAssemblyTab() {
  const niche     = currentNiche;
  const beats     = niche ? getBeatData(niche) : [];
  const voiceFile = localStorage.getItem('lastVoiceFile') || null;

  // ── Status badge row ───────────────────────────────────────────────────
  const nicheLabels = { stickman: 'Stickman POV', medical: 'Medical', history: 'Map History', geo: 'Geo What-If', other: 'Other Niche' };
  const badge = (icon, label, ok) =>
    `<div style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;
      background:${ok ? 'rgba(34,197,94,0.1)' : 'rgba(107,114,128,0.12)'};
      border:1px solid ${ok ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'};
      color:${ok ? '#4ade80' : '#6b7280'};">
      ${icon} ${escapeHTML(label)}
    </div>`;

  get('assembly-status-row').innerHTML = [
    badge('🎯', niche ? nicheLabels[niche] : 'No niche selected', !!niche),
    badge('🖼', beats.length ? `${beats.length} scenes` : 'No scenes yet', beats.length > 0),
    badge('🔊', voiceFile || 'No voice file yet', !!voiceFile),
  ].join('');

  // ── No-beats warning ──────────────────────────────────────────────────
  get('assembly-no-beats-msg').style.display = beats.length ? 'none' : 'block';
  get('assembly-clip-field').style.display   = beats.length ? 'block' : 'none';

  // ── Auto-fill script textarea if empty ───────────────────────────────
  const scriptTextarea = get('assembly-script');
  if (!scriptTextarea.value.trim()) {
    // Prefer Script Refiner output; fall back to the niche script generator
    const refinerEl = get('script-text');
    const scriptElMap = { stickman: 'prompt-text', medical: 'medical-text', history: 'history-text', geo: 'geo-text', other: 'other-text' };
    const srcEl = (refinerEl?.innerText.trim()) ? refinerEl : (niche ? get(scriptElMap[niche]) : null);
    if (srcEl && srcEl.innerText.trim()) {
      // Extract plain text from the rendered HTML (strips inline markers' colour wrappers)
      scriptTextarea.value = srcEl.innerText.trim();
    }
  }
}

async function generateAssembly() {
  const script    = get('assembly-script').value.trim();
  const voiceFile = localStorage.getItem('lastVoiceFile') || 'narration.wav';
  const beats     = currentNiche ? getBeatData(currentNiche) : [];

  if (!script) return showToast('Generate your script first — it should auto-fill, or paste it manually.', 'error');
  if (!beats.length) return showToast('No scenes found. Run the Image Planner first, then come back.', 'error');

  // Parse clip beat numbers from the simple text input (e.g. "3, 7, 12")
  const clipInput = (get('assembly-clip-beats')?.value || '').trim();
  const clipBeats = clipInput
    ? clipInput.split(/[\s,;]+/).map(n => parseInt(n)).filter(n => !isNaN(n))
    : [];

  const assetList = beats.map(b => {
    const hasClip = clipBeats.includes(b.num);
    const label   = b.scriptLine ? ` — "${b.scriptLine.slice(0, 60)}"` : '';
    return `Scene ${b.num}${label}: ${hasClip ? `scene-${b.num}.mp4 (Veo 3 video clip)` : `scene-${b.num}.jpg (AI still image — apply Ken Burns zoom)`}`;
  }).join('\n');

  const nicheLabel = {
    stickman: 'Stickman POV',
    medical: 'Medical',
    history: 'History',
    geo: 'Geo',
  }[currentNiche] || 'General';

  const nicheRules = {
    stickman: `NICHE EDITING RULES — STICKMAN POV:
- Hard cut between every single beat — never use crossfades or dissolves
- Target beat duration: 4–6 seconds maximum. If a beat would exceed 6s, note "PACE WARNING" in EFFECT
- Music: one drone note only. If any [AUDIO NOTE] says anything other than a drone, write "⚠ WRONG MUSIC CUE" in EFFECT for that beat
- For still images: Ken Burns zoom only (scale 1.0 → 1.06), then hard cut — write "KB ZOOM + HARD CUT" in EFFECT
- For video clips: write "HARD CUT" in EFFECT
- Text overlays: bold, centred, white on black bar — write style in TEXT OVERLAY column`,

    medical: `NICHE EDITING RULES — MEDICAL:
- Tag every beat TYPE-A or TYPE-B in parentheses at the start of the EFFECT column
  - TYPE-A: body interior / anatomy / cellular / organ visuals → slow zoom push in (scale 1.0 → 1.12, ease-in-out)
  - TYPE-B: external / reaction / patient / doctor visuals → straight cut
- For TYPE-A stills: combine Ken Burns zoom (scale 1.0 → 1.10) with slow push; write "(TYPE-A) KB ZOOM PUSH"
- For TYPE-B stills: standard Ken Burns zoom (scale 1.0 → 1.08); write "(TYPE-B) KB ZOOM"
- Escalation beats (sudden reveal, diagnosis moment): add "IMPACT FRAME — 2 frames white flash" to EFFECT
- Text overlays: clean sans-serif, white, left-aligned — note in TEXT OVERLAY column`,

    history: `NICHE EDITING RULES — HISTORY:
- At each new script section heading, insert an ACT BANNER beat before the first content beat of that section
  - Write "ACT BANNER: [section title]" in TEXT OVERLAY and "BANNER HOLD 1.5s" in EFFECT
- All on-screen text: parchment-style serif font — append "[PARCHMENT FONT]" to every TEXT OVERLAY entry
- Default transition: crossfade 0.4s — write "CROSSFADE 0.4s" in TRANSITION column
- If the script mentions territory names, colours, or empires, list them after the table as: COLOUR ASSIGNMENT — [Territory]: [colour]
- Battle or conflict beats: write "SEPIA GRADE" in EFFECT to flag colour treatment`,

    geo: `NICHE EDITING RULES — GEO:
- Fast cuts throughout: target 3–5 seconds per beat; flag any beat over 5s with "⚠ TOO SLOW" in EFFECT
- All text overlays: handwritten-style font — append "[HANDWRITTEN FONT]" to every TEXT OVERLAY entry
- Identify the single escalation beat (the peak tension / reveal moment in the script):
  - Mark it "ESCALATION — SILENCE" in EFFECT; write "REMOVE MUSIC HERE" in TEXT OVERLAY
  - Flag any [AUDIO NOTE] on that beat as "⚠ REMOVE — MUST BE SILENT" in EFFECT
- Default transition: straight cut — write "CUT" in TRANSITION
- Map zoom beats (aerial establishing shots): write "MAP ZOOM IN" or "MAP ZOOM OUT" in EFFECT`,
  };

  const nicheRuleBlock = nicheRules[currentNiche] || '';

  const SYS = `You are a professional video editor and post-production supervisor specialising in ${nicheLabel} short-form YouTube content. Your job is to take finished production assets (narration audio, still images, video clips, script markers) and produce a precise, edit-ready assembly plan that any editor can follow without asking questions.

You must:
- Be specific with every timecode, duration, and effect instruction
- Apply the niche editing rules exactly as given — do not improvise around them
- Flag every problem clearly (gaps, wrong cues, pace warnings) so nothing is missed
- Output a clean, structured document that reads like a professional edit decision list (EDL)`;

  const USER = `Produce a complete assembly plan for this ${nicheLabel} YouTube video.

═══════════════════════════════════════
ASSETS
═══════════════════════════════════════
NARRATION AUDIO: ${voiceFile}
  Format: 24kHz / 16-bit / Mono WAV — exported from Voice Generator
  Assume audio has already been noise-cleaned and normalised to -14 LUFS

VISUAL ASSETS (${beats.length} scenes):
${assetList}

═══════════════════════════════════════
SCRIPT
═══════════════════════════════════════
${script}

═══════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════
STEP 1 — WORD COUNT & DURATION
  a. Count only spoken narration words — skip everything in [square brackets]
  b. Estimate total duration at 150 words/minute
  c. Add 1.5s of black at the start (cold open hold) and 2s at the end (outro hold)

STEP 2 — PER-SCENE TIMING
  a. Distribute the narration duration across all ${beats.length} scenes proportionally
     — scenes with more script text get more time, short punchy scenes get less
  b. Round each scene to the nearest 0.5s
  c. Verify all scene durations sum to total narration duration ± 1s

STEP 3 — EFFECTS
  a. For every still image scene: apply slow Ken Burns zoom (scale 1.0 → 1.08 unless niche rules say otherwise)
  b. For every video clip scene: play at 100% speed unless script says [SLOW MO] or [SPEED RAMP]
  c. Apply [TRANSITION] markers — default: straight cut if no marker present
  d. Apply [SPEED RAMP] or [SLOW MO] markers to the correct scene EFFECT column

STEP 4 — TEXT OVERLAYS
  a. Extract every [ON-SCREEN TEXT: …] marker and assign to the correct scene
  b. Each text overlay: 0.5s fade-in, hold until next scene, 0.3s fade-out
  c. Note the text content and style in the TEXT OVERLAY column

STEP 5 — AUDIO CUES
  a. Map every [AUDIO NOTE] marker to a timecode-stamped MUSIC CUE line
  b. If there is no [AUDIO NOTE] marker, write "MUSIC CUE — continuous background track" at 00:00

STEP 6 — GAP CHECK
  Flag any timecode range with no visual asset — write "⚠ GAP: no visual [START–END]" in FLAGS

${nicheRuleBlock ? `STEP 7 — NICHE RULES (apply strictly)\n${nicheRuleBlock}\n` : ''}
═══════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════
Produce exactly three sections in this order:

SECTION 1: SUMMARY
- Spoken word count: [n] words
- Estimated narration duration: [mm:ss]
- Total video duration (with holds): [mm:ss]
- Scenes: [n] total — [n] video clips, [n] stills
- ⚠ FLAGS: [list any gaps, wrong cues, pace warnings, or niche violations — or write "None"]

SECTION 2: TIMELINE TABLE
One row per scene. Use | as column separator. Include a header row.
Columns: SCENE | START | END | DURATION | FILE | EFFECT | TEXT OVERLAY | TRANSITION

Rules for the table:
- SCENE: scene number (1, 2, 3 …)
- START / END: timecode in mm:ss format (e.g. 00:04)
- DURATION: in seconds (e.g. 5.5s)
- FILE: exact filename from the asset list
- EFFECT: specific effect instruction (see niche rules and step 3)
- TEXT OVERLAY: extracted text or "—" if none
- TRANSITION: cut / crossfade Xs / wipe / "—"

SECTION 3: MUSIC CUES
List every music cue as:
MUSIC CUE — [mm:ss]: [exact instruction]

If there are colour assignments (history niche), list them after SECTION 3 as:
COLOUR ASSIGNMENT — [Territory]: [colour hex or name]`;


  const btn = get('generate-assembly-btn');
  setLoading(btn, '🎞 Generate Edit Timeline');

  const result = await callGemini(SYS, USER);
  setLoading(btn, '🎞 Generate Edit Timeline', false);

  if (result.error) return showToast(result.error, 'error');

  const resultEl = get('assembly-result');
  const rawText  = result.text;

  // ── Parse into blocks ─────────────────────────────────────────────────────
  const lines  = rawText.split('\n');
  const blocks = [];
  let tableRows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('|')) {
      tableRows.push(trimmed);
    } else {
      if (tableRows.length) { blocks.push({ type: 'table', rows: tableRows }); tableRows = []; }
      blocks.push({ type: 'line', text: trimmed });
    }
  }
  if (tableRows.length) blocks.push({ type: 'table', rows: tableRows });

  // ── Row colour logic ──────────────────────────────────────────────────────
  function rowBg(cells) {
    // cells[4] = EFFECT column (0-indexed after filtering leading empty)
    const effect = (cells[4] || '').toLowerCase();
    const file   = (cells[3] || '').toLowerCase();
    if (effect.includes('⚠') || effect.includes('gap') || effect.includes('wrong') || effect.includes('remove')) {
      return 'rgba(239,68,68,0.10)';   // red — problem
    }
    if (effect.includes('escalation') || effect.includes('silence') || effect.includes('pace warning')) {
      return 'rgba(245,158,11,0.10)';  // amber — warning
    }
    if (effect.includes('banner hold') || effect.includes('act banner')) {
      return 'rgba(139,92,246,0.12)';  // purple — act banner
    }
    if (file.includes('.mp4') || effect.includes('hard cut') && !effect.includes('kb')) {
      return 'rgba(34,197,94,0.08)';   // green — video clip
    }
    if (file.includes('.jpg') || effect.includes('kb zoom') || effect.includes('ken burns')) {
      return 'rgba(234,179,8,0.08)';   // yellow — still
    }
    return 'transparent';
  }

  // ── Render ────────────────────────────────────────────────────────────────
  resultEl.innerHTML = blocks.map(block => {
    if (block.type === 'table') {
      const rowsHtml = block.rows.map(row => {
        if (/^\|?[-:| ]+\|?$/.test(row)) return ''; // separator row
        const isHeader = /^BEAT\b/i.test(row.replace(/^\|/, '').trim());
        const cells    = row.split('|').map(c => c.trim()).filter((c, i) => i > 0 || c);
        const tag      = isHeader ? 'th' : 'td';

        const headerCellStyle = 'padding:7px 10px;border:1px solid rgba(255,255,255,0.12);font-size:10px;color:#c084fc;font-weight:700;background:rgba(124,58,237,0.12);text-transform:uppercase;letter-spacing:.07em;white-space:nowrap;';
        const bg = isHeader ? '' : rowBg(cells);
        const dataCellStyle = `padding:5px 10px;border:1px solid rgba(255,255,255,0.06);font-size:11px;color:#ddd;background:${bg};vertical-align:top;`;

        return `<tr style="${isHeader ? '' : `background:${bg};`}">${
          cells.map((c) => {
            // Highlight warning text in red, amber
            let content = escapeHTML(c);
            if (!isHeader) {
              content = content
                .replace(/(⚠[^<]*)/g, '<span style="color:#f87171;font-weight:600;">$1</span>')
                .replace(/\b(WRONG|REMOVE|GAP|MISSING)\b/g, '<span style="color:#f87171;font-weight:600;">$1</span>')
                .replace(/\b(PACE WARNING|TOO SLOW)\b/g, '<span style="color:#fcd34d;font-weight:600;">$1</span>')
                .replace(/\b(TYPE-A|TYPE-B)\b/g, '<span style="color:#818cf8;font-weight:600;">$1</span>')
                .replace(/\b(ESCALATION|SILENCE)\b/g, '<span style="color:#f59e0b;font-weight:600;">$1</span>');
            }
            return `<${tag} style="${isHeader ? headerCellStyle : dataCellStyle}">${content}</${tag}>`;
          }).join('')
        }</tr>`;
      }).filter(Boolean).join('');

      return `<div style="overflow-x:auto;margin:10px 0;">
        <div style="margin-bottom:4px;font-size:10px;color:#6b7280;">
          <span style="display:inline-block;width:10px;height:10px;background:rgba(34,197,94,0.3);border:1px solid #22c55e;border-radius:2px;margin-right:4px;vertical-align:middle;"></span>Clip
          <span style="display:inline-block;width:10px;height:10px;background:rgba(234,179,8,0.3);border:1px solid #eab308;border-radius:2px;margin-right:4px;margin-left:10px;vertical-align:middle;"></span>Still
          <span style="display:inline-block;width:10px;height:10px;background:rgba(239,68,68,0.3);border:1px solid #ef4444;border-radius:2px;margin-right:4px;margin-left:10px;vertical-align:middle;"></span>Problem
          <span style="display:inline-block;width:10px;height:10px;background:rgba(245,158,11,0.3);border:1px solid #f59e0b;border-radius:2px;margin-right:4px;margin-left:10px;vertical-align:middle;"></span>Warning
        </div>
        <table style="border-collapse:collapse;width:100%;min-width:700px;">${rowsHtml}</table>
      </div>`;
    }

    const t = block.text;
    if (!t) return '<div style="height:5px;"></div>';

    if (/^SECTION\s+\d/.test(t)) {
      const [, num, ...rest] = t.match(/^(SECTION\s+\d+)[:\s–—]*(.*)$/) || [, t, ''];
      return `<div style="display:flex;align-items:center;gap:8px;margin:20px 0 8px;">
        <div style="background:#7c3aed;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;white-space:nowrap;">${escapeHTML(num)}</div>
        <div style="font-size:13px;font-weight:700;color:#e2e8f0;">${escapeHTML(rest.join(' ').trim())}</div>
        <div style="flex:1;height:1px;background:rgba(255,255,255,0.08);"></div>
      </div>`;
    }
    if (t.startsWith('MUSIC CUE')) {
      return `<div style="padding:6px 12px;background:rgba(251,191,36,0.07);border-left:3px solid #f59e0b;border-radius:4px;font-size:11px;color:#fcd34d;margin:2px 0;font-family:monospace;">${escapeHTML(t)}</div>`;
    }
    if (t.startsWith('COLOUR ASSIGNMENT')) {
      return `<div style="padding:6px 12px;background:rgba(99,102,241,0.07);border-left:3px solid #6366f1;border-radius:4px;font-size:11px;color:#a5b4fc;margin:2px 0;">${escapeHTML(t)}</div>`;
    }
    if (t.includes('⚠') || /\b(GAP|WRONG|MISSING|FLAG)\b/.test(t)) {
      return `<div style="padding:6px 12px;background:rgba(239,68,68,0.08);border-left:3px solid #ef4444;border-radius:4px;font-size:11px;color:#fca5a5;margin:2px 0;">${escapeHTML(t)}</div>`;
    }
    if (t.startsWith('- ') || t.startsWith('• ')) {
      return `<div style="font-size:12px;color:#9ca3af;padding:1px 0 1px 12px;line-height:1.7;">${escapeHTML(t)}</div>`;
    }
    if (/^[A-Z][A-Z\s:]+$/.test(t) && t.length > 4) {
      return `<div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 3px;">${escapeHTML(t)}</div>`;
    }
    return `<div style="font-size:12px;color:#9ca3af;line-height:1.8;">${escapeHTML(t)}</div>`;
  }).join('');

  // ── Download button ───────────────────────────────────────────────────────
  const existingDl = get('assembly-download-btn');
  if (existingDl) existingDl.remove();

  const dlBtn = document.createElement('button');
  dlBtn.id        = 'assembly-download-btn';
  dlBtn.className = 'ccp-btn-secondary';
  dlBtn.style.cssText = 'margin-top:14px;font-size:12px;';
  dlBtn.textContent   = '⬇ Download Timeline as TXT';
  dlBtn.onclick = () => {
    const blob = new Blob([rawText], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `timeline-${currentNiche || 'video'}-${Date.now()}.txt` });
    a.click();
    URL.revokeObjectURL(url);
  };
  get('assembly-result').after(dlBtn);

  get('assembly-output').style.display = 'flex';
  markPipelineStep(currentNiche, 'assembly');
}

// ─── Other / Other Niche ───────────────────────────────────────────────

async function callGeminiWithVideo(youtubeUrl, systemPrompt, userPrompt) {
  const geminiKey = getGeminiKey();
  if (!hasApiAccess()) return { error: 'Add your Gemini API key in ⚙️ Settings.' };

  // Normalise short URLs: youtu.be/ID → youtube.com/watch?v=ID
  let videoUrl = youtubeUrl;
  const shortenMatch = youtubeUrl.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  if (shortenMatch) videoUrl = `https://www.youtube.com/watch?v=${shortenMatch[1]}`;

  // Models with confirmed YouTube URL fileData support, tried in order
  const VIDEO_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash'];

  for (let mi = 0; mi < VIDEO_MODELS.length; mi++) {
    const videoModel = VIDEO_MODELS[mi];
    let fullText  = '';
    const contents = [{
      role: 'user',
      parts: [
        { fileData: { fileUri: videoUrl } },
        { text: userPrompt }
      ]
    }];

    let modelUnavailable = false;

    for (let pass = 0; pass < 3; pass++) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
        try {
          const response = await _geminiFetch(videoModel, {
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents,
              generationConfig: { maxOutputTokens: 65536, temperature: 1.0 }
            });
          if (response.status === 503 || response.status === 429) { if (attempt === 0) continue; break; }
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const msg = err?.error?.message || `API Error: HTTP ${response.status}`;
            // Only skip to next model if THIS model doesn't exist for this key (404)
            if (response.status === 404) { modelUnavailable = true; break; }
            return { error: msg };
          }
          const data         = await response.json();
          const candidate    = data?.candidates?.[0];
          const chunk        = candidate?.content?.parts?.[0]?.text || '';
          const finishReason = candidate?.finishReason;
          if (!chunk && pass === 0) {
            const blockReason = data?.promptFeedback?.blockReason;
            const safetyMsg   = blockReason ? ` (${blockReason})` : '';
            return { error: `Gemini could not process the video${safetyMsg}. Make sure it is a public YouTube video.` };
          }
          fullText += chunk;
          if (finishReason === 'STOP' || finishReason === 'END_OF_TURN' || !finishReason) return { text: fullText };
          if (finishReason === 'MAX_TOKENS') {
            contents.push({ role: 'model', parts: [{ text: chunk }] });
            contents.push({ role: 'user',  parts: [{ text: 'Continue exactly from where you stopped. Do not repeat anything.' }] });
            break;
          }
          if (fullText) return { text: fullText };
        } catch (err) { if (attempt === 1) return { error: `Network Error: ${err.message}` }; }
      }
      if (modelUnavailable) break;
    }

    if (!modelUnavailable && fullText) return { text: fullText };
    if (!modelUnavailable) return { error: 'Gemini stopped early. Try again.' };
    // else: model unavailable — loop to next model
  }

  return { error: 'YouTube video analysis is not available on your API key tier. Make sure the video is public, or upgrade to a paid Gemini API plan.' };
}

// Fetch full transcript from Supadata API
async function fetchYouTubeTranscript(videoUrl) {
  const key = getSupadataKey();
  if (!key) return { error: 'no_key' };

  // Supadata expects the video ID, not the full URL
  const idMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  const videoId = idMatch ? idMatch[1] : videoUrl;

  try {
    const response = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}&text=true`,
      { headers: { 'x-api-key': key } }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { error: err?.message || `Supadata error: HTTP ${response.status}` };
    }
    const data = await response.json();
    const text = data.content || data.text || data.transcript || '';
    return { text, lang: data.lang || 'en' };
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// Search YouTube via Supadata — returns array of { title, channel } or empty array
async function searchYouTube(query, limit = 8) {
  const key = getSupadataKey();
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/search?query=${encodeURIComponent(query)}&type=video&limit=${limit}`,
      { headers: { 'x-api-key': key } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ title: r.title || '', channel: r.channel?.name || '' }));
  } catch { return []; }
}

// Fetch video title + channel name from YouTube's public oEmbed API (no auth, CORS-friendly)
async function fetchVideoMeta(videoUrl) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
    if (!res.ok) return {};
    const d = await res.json();
    return {
      videoTitle:  d.title        || '',
      channelName: d.author_name  || '',
      channelLink: d.author_url   || videoUrl,
    };
  } catch { return {}; }
}

async function analyzeReferenceVideo() {
  const url = get('other-url').value.trim();
  if (!url) return showToast('Paste a YouTube URL first.', 'error');
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) return showToast('Please use a YouTube URL.', 'error');

  const btn         = get('analyze-video-btn');
  const analysisEl  = get('other-analysis-result');
  const outputWrap  = get('other-analysis-output');
  const topicsSection = get('other-topics-section');
  const topicCards    = get('other-topic-cards');

  const showInline = (msg, isError) => {
    analysisEl.innerHTML = `<div style="font-size:12px;color:${isError ? '#f87171' : '#9ca3af'};padding:8px 0;">${msg}</div>`;
    outputWrap.style.display = 'flex';
  };

  btn.disabled = true;
  topicsSection.style.display = 'none';

  // ── Step 0: Fetch real video metadata from YouTube oEmbed ─────────────
  showInline('Looking up video…');
  const meta = await fetchVideoMeta(url);
  let knownTitle   = meta.videoTitle  || '';
  let knownChannel = meta.channelName || '';
  let knownChanUrl = meta.channelLink || url;

  // ── Step 1: Fetch transcript (Supadata → Gemini video fallback) ─────────
  let transcriptText = '';
  let transcriptError = '';
  const supadataKey = getSupadataKey();

  const _extractViaGemini = async () => {
    const geminiTr = await callGeminiWithVideo(
      url,
      'You are a transcription assistant. Output only the spoken words from the video — no timestamps, no labels, no commentary.',
      'Transcribe every word spoken in this video in full. Output only the transcript text, nothing else.'
    );
    return geminiTr.error ? null : geminiTr.text.trim();
  };

  if (supadataKey) {
    btn.querySelector('span').textContent = 'Fetching transcript…';
    showInline('Fetching transcript from YouTube…');
    const tr = await fetchYouTubeTranscript(url);
    if (tr.error && tr.error !== 'no_key') {
      // Supadata failed — fall back to Gemini native video understanding
      showInline('Supadata limit reached — extracting transcript via Gemini…');
      btn.querySelector('span').textContent = 'Extracting transcript…';
      const geminiText = await _extractViaGemini();
      if (geminiText) {
        transcriptText = geminiText;
      } else {
        transcriptError = tr.error;
      }
    } else {
      transcriptText = tr.text || '';
    }
  } else {
    // No Supadata key — use Gemini directly
    btn.querySelector('span').textContent = 'Extracting transcript…';
    showInline('Extracting transcript via Gemini…');
    const geminiText = await _extractViaGemini();
    if (geminiText) {
      transcriptText = geminiText;
    } else {
      transcriptError = 'no_key';
    }
  }

  // ── Step 2: Analyse ───────────────────────────────────────────────────
  btn.querySelector('span').textContent = 'Analysing video…';
  showInline(transcriptText ? 'Transcript fetched — analysing style and structure…' : 'Researching video via Google Search…');

  let r1;

  if (transcriptText) {
    // Have real transcript — send to Gemini with search for channel lookup
    const transcriptBlock = transcriptText; // always send full transcript

    const metaBlock = knownTitle
      ? `CONFIRMED VIDEO METADATA (already fetched — use these exact values, do NOT override them):
- Video title: ${knownTitle}
- Channel name: ${knownChannel}
- Channel URL: ${knownChanUrl}

`     : '';

    const PROMPT = `${metaBlock}Analyse the transcript below and produce a breakdown in EXACTLY this format — no extra commentary:

CHANNEL
- Channel name: ${knownChannel || '[search for it]'}
- Channel URL: ${knownChanUrl || '[search for it]'}
- Niche/category: [one phrase describing the channel's content]
- Video title: ${knownTitle || '[search for it]'}

VIDEO STATS
- Runtime: [estimate from word count at 150 wpm]
- Approximate spoken word count: [count transcript words]
- Number of segments/sections: [n]

STYLE BREAKDOWN
- Tone & voice: [narration style]
- Pacing: [fast/medium/slow — based on transcript density]
- Hook style: [describe the opening lines of the transcript]
- Outro/CTA style: [describe how the transcript ends]
- Music style: [infer from content type]

VISUAL STYLE
- Overall visual approach: [infer from content type]
- Colour palette: [infer or note as unknown]
- Motion graphics: [infer or note as unknown]
- Text overlay style: [infer or note as unknown]

SCRIPT STRUCTURE
[Map the transcript into structural sections with timings]

FULL TRANSCRIPT:
${transcriptBlock}`;
    r1 = await callGeminiWithSearch(PROMPT);
  } else {
    // No transcript — search-only analysis
    const metaBlock = knownTitle
      ? `CONFIRMED VIDEO METADATA (already fetched — use these exact values):
- Video title: ${knownTitle}
- Channel name: ${knownChannel}
- Channel URL: ${knownChanUrl}

`     : '';

    const PROMPT = `You have access to Google Search. Use it now — do not guess.

${metaBlock}VIDEO URL: ${url}

${knownTitle ? 'STEP 1 — Search for the channel niche and content style using the channel name above.' : 'STEP 1 — Search for this video URL. Find its exact title and channel name.'}
STEP 2 — Search for "${knownTitle || '[video title]'} transcript" to find the spoken script or captions.
STEP 3 — Produce a breakdown in EXACTLY this format — no extra commentary:

CHANNEL
- Channel name: ${knownChannel || '[name]'}
- Channel URL: ${knownChanUrl || '[youtube.com/@handle]'}
- Niche/category: [one phrase]
- Video title: ${knownTitle || '[exact title]'}

VIDEO STATS
- Runtime: [mm:ss]
- Approximate spoken word count: [n words]
- Number of segments/sections: [n]

STYLE BREAKDOWN
- Tone & voice: [narration style — formal/conversational, person, dramatic/calm]
- Pacing: [fast/medium/slow and how]
- Hook style: [exactly how the first 30 seconds opens]
- Outro/CTA style: [how the video ends]
- Music style: [mood and instrumentation]

VISUAL STYLE
- Overall visual approach: [animation/live/stock/motion graphics]
- Colour palette: [dominant colours and mood]
- Motion graphics: [text animations, lower thirds, transitions]
- Text overlay style: [font style, positioning, frequency]

SCRIPT STRUCTURE
[Exact structural pattern — e.g. "Hook (30s) → Context (60s) → 3 main points (2min each) → CTA (20s)"]`;
    r1 = await callGeminiWithSearch(PROMPT);
  }

  if (r1.error) {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Analyse & Find Topics';
    showInline(`Analysis failed: ${r1.error}`, true);
    return;
  }

  currentOtherAnalysis   = r1.text;
  currentOtherVideoUrl   = url;
  currentOtherTranscript = transcriptText;

  // Extract runtime, channel info, visual style
  const runtimeMatch = r1.text.match(/Runtime:\s*([\d:]+)/i);
  currentOtherRuntime = runtimeMatch ? runtimeMatch[1] : '';

  const styleMatch = r1.text.match(/VISUAL STYLE([\s\S]*?)(?=SCRIPT STRUCTURE|$)/i);
  currentOtherStyle = styleMatch ? styleMatch[1].trim() : '';

  const channelNameMatch = r1.text.match(/Channel name:\s*(.+)/i);
  const channelUrlMatch  = r1.text.match(/Channel URL:\s*(.+)/i);
  const channelNiche     = r1.text.match(/Niche\/category:\s*(.+)/i);
  const videoTitleMatch  = r1.text.match(/Video title:\s*(.+)/i);

  // Prefer oEmbed values (always accurate) over Gemini-parsed values
  const isPlaceholder = v => !v || /unable|unknown|determine|n\/a|\[/i.test(v);
  const channelName = knownChannel || (isPlaceholder(channelNameMatch?.[1]?.trim()) ? 'the reference channel' : channelNameMatch[1].trim());
  const channelLink = knownChanUrl || (isPlaceholder(channelUrlMatch?.[1]?.trim())  ? url                    : channelUrlMatch[1].trim());
  const nicheLabel  = channelNiche?.[1]?.trim() || 'YouTube';
  const videoTitle  = knownTitle   || (isPlaceholder(videoTitleMatch?.[1]?.trim())  ? ''                     : videoTitleMatch[1].trim());

  // Render analysis (skip CHANNEL section — show cleanly)
  let html = '';
  const lines = r1.text.split('\n');
  let skipSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { html += '<div style="height:4px;"></div>'; continue; }
    if (/^CHANNEL$/i.test(t)) { skipSection = true; continue; }
    if (/^(VIDEO STATS|STYLE BREAKDOWN|VISUAL STYLE|SCRIPT STRUCTURE)$/i.test(t)) {
      skipSection = false;
      html += `<div style="font-size:10px;font-weight:700;color:#c084fc;text-transform:uppercase;letter-spacing:.07em;margin:14px 0 5px;">${escapeHTML(t)}</div>`;
    } else if (!skipSection) {
      if (t.startsWith('-')) {
        html += `<div style="font-size:12px;color:#9ca3af;padding:1px 0 1px 10px;line-height:1.7;">${escapeHTML(t)}</div>`;
      } else {
        html += `<div style="font-size:12px;color:#d1d5db;line-height:1.7;">${escapeHTML(t)}</div>`;
      }
    }
  }
  // Channel badge + video title
  const titleRow = videoTitle
    ? `<div style="margin-bottom:12px;padding:8px 12px;background:rgba(124,58,237,0.07);border:1px solid rgba(124,58,237,0.18);border-radius:8px;">
        <div style="font-size:9px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;">Reference Video</div>
        <div style="font-size:13px;font-weight:600;color:#e9d5ff;line-height:1.4;">${escapeHTML(videoTitle)}</div>
      </div>`
    : '';
  html = `<div style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;background:rgba(255,0,0,0.08);border:1px solid rgba(255,0,0,0.2);border-radius:8px;margin-bottom:10px;">
    <svg width="14" height="10" viewBox="0 0 18 13" fill="none"><path d="M17.64 2.03A2.26 2.26 0 0 0 16.06.45C14.65 0 9 0 9 0S3.35 0 1.94.45A2.26 2.26 0 0 0 .36 2.03C0 3.44 0 6.5 0 6.5s0 3.06.36 4.47a2.26 2.26 0 0 0 1.58 1.58C3.35 13 9 13 9 13s5.65 0 7.06-.45a2.26 2.26 0 0 0 1.58-1.58C18 9.56 18 6.5 18 6.5s0-3.06-.36-4.47Z" fill="#FF0000"/><path d="M7.2 9.25L11.88 6.5 7.2 3.75v5.5Z" fill="white"/></svg>
    <span style="font-size:12px;font-weight:600;color:#fca5a5;">${escapeHTML(channelName)}</span>
    <span style="font-size:11px;color:#6b7280;">· ${escapeHTML(nicheLabel)}</span>
  </div>` + titleRow + html;

  // Full transcript — always fully expanded, no scroll cap
  if (transcriptText) {
    const wordCount = transcriptText.split(/\s+/).filter(Boolean).length;
    const estMins   = Math.round(wordCount / 150);
    html += `<div style="margin-top:22px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;color:#c084fc;text-transform:uppercase;letter-spacing:.07em;">Full Transcript</div>
        <div style="display:flex;gap:8px;">
          <span style="font-size:11px;padding:2px 9px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);border-radius:20px;color:#a78bfa;">${wordCount.toLocaleString()} words</span>
          <span style="font-size:11px;padding:2px 9px;background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);border-radius:20px;color:#a78bfa;">~${estMins} min</span>
        </div>
      </div>
      <div style="padding:18px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.07);border-radius:12px;font-size:13px;color:#c4c9d4;line-height:2;white-space:pre-wrap;">${escapeHTML(transcriptText)}</div>
    </div>`;
  } else {
    const msg = transcriptError === 'no_key'
      ? 'Transcript could not be extracted. Add a Supadata API key in ⚙️ Settings for best results.'
      : `Transcript unavailable: ${transcriptError}`;
    html += `<div style="margin-top:18px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;font-size:12px;color:#6b7280;">${escapeHTML(msg)}</div>`;
  }

  analysisEl.innerHTML = html;
  outputWrap.style.display = 'flex';

  // ── Step 3: Search for viral topics + extract visual style guide (parallel) ──
  btn.querySelector('span').textContent = 'Loading…';
  topicsSection.style.display = 'none';
  topicCards.innerHTML = `<div class="ccp-loading-row"><span class="ccp-spinner"></span>Loading…</div>`;
  topicsSection.style.display = 'block';

  const _styleGuideSYS = 'You are a creative director specialising in YouTube animation. You watch videos and produce precise, replicable animation style guides that can be used to recreate the exact visual look of every frame.';
  const _styleGuideUSER = `Watch this video in full.

Extract an ANIMATION STYLE GUIDE in exactly this format:

ART STYLE: [e.g. flat 2D vector / 3D animation / motion graphics / live action + graphics]
COLOUR PALETTE: [list dominant colours with descriptions, e.g. "deep navy #1a1a2e, bright red #e94560, white text on dark"]
CHARACTER DESIGN: [e.g. simple black silhouettes / no faces / detailed cartoon characters / stick figures]
BACKGROUND STYLE: [e.g. solid dark colour / illustrated environments / real photos / gradient washes]
TEXT OVERLAYS: [font style, placement, colour, size, how frequently they appear]
CAMERA MOVEMENT: [e.g. slow zoom in / static wide / pan left-right / pull back reveal]
TRANSITION STYLE: [e.g. hard cut / fade to black between segments / whip pan / slide wipe]
LIGHTING: [e.g. high contrast dramatic / flat even / glowing neon accents / cinematic dark]
MOOD: [e.g. ominous and tense / upbeat educational / cinematic epic / clinical and cold]
PACING: [e.g. new visual every 4-6 seconds / holds on image during narration / rapid cuts every 2s]

RECREATION PROMPT BASE: [Write a single reusable image generation prompt — 3 to 5 sentences — that captures ALL of the above. This will be prepended to every scene description to guarantee every frame looks like it came from the same video. Be highly specific about colours, art style, rendering technique, and mood.]`;

  const [topicResult, styleGuideResult] = await Promise.all([
    _searchForTopics(channelName, channelLink, nicheLabel, r1.text, [], videoTitle, url, 5, transcriptText),
    callGeminiWithVideo(url, _styleGuideSYS, _styleGuideUSER),
  ]);

  if (!styleGuideResult.error && styleGuideResult.text) {
    currentOtherVisualStyleGuide = styleGuideResult.text;
  }

  btn.disabled = false;
  btn.querySelector('span').textContent = 'Analyse & Find Topics';

  if (topicResult.error) {
    topicCards.innerHTML = `<div style="font-size:12px;color:#f87171;padding:8px 0;">Could not load topics: ${escapeHTML(topicResult.error)}</div>`;
    return;
  }

  _renderTopicCards(topicCards, topicResult.topics, 0);
  updateStyleLockBadge();
  markPipelineStep('other', 'script');
}

// Shared topic search used by both analyzeReferenceVideo and generateMoreTopicIdeas
async function _searchForTopics(channelName, channelLink, niche, analysisContext, existingTitles, referenceVideoTitle = '', videoUrl = '', count = 5, transcriptText = '') {
  const existingBlock = existingTitles.length
    ? `ALREADY SUGGESTED — do NOT repeat these:\n${existingTitles.map(t => `- ${t}`).join('\n')}\n\n`
    : '';

  // Send full analysis (it's already structured — don't truncate)
  const analysisSnippet = analysisContext
    ? analysisContext.split('\n').filter(l => l.trim()).slice(0, 80).join('\n')
    : '';

  // Add the first 300 words of the transcript as concrete niche context
  const transcriptSnippet = transcriptText
    ? `\nREFERENCE VIDEO OPENING (first 300 words — use this to understand the EXACT content type, tone, and subject matter):\n${transcriptText.split(/\s+/).slice(0, 300).join(' ')}\n`
    : '';

  // ── Phase 0: discover what's already heavily covered so Phase 1 can avoid it ──
  const searchQueries = [
    searchYouTube(`${niche}`, 8),
    referenceVideoTitle ? searchYouTube(referenceVideoTitle, 8) : Promise.resolve([]),
  ];
  const [famousA, famousB] = await Promise.all(searchQueries);
  const famousBlacklist = [...new Set([...famousA, ...famousB].map(r => r.title).filter(Boolean))].slice(0, 20);
  const blacklistBlock = famousBlacklist.length
    ? `\nALREADY COVERED ON YOUTUBE — do NOT suggest anything similar to these:\n${famousBlacklist.map(t => `- ${t}`).join('\n')}\n`
    : '';

  // ── Phase 1: catalogue channel + brainstorm candidates ──────────────────
  const p1 = await callGeminiWithSearch(
    `You have access to Google Search. Use it now.

CHANNEL: ${channelName} (${channelLink})
REFERENCE VIDEO: "${referenceVideoTitle}"
${analysisSnippet ? `CHANNEL ANALYSIS:\n${analysisSnippet}\n` : ''}${transcriptSnippet}
${blacklistBlock}
STEP 1 — Search YouTube for "${channelName}". List 15 real video titles from that channel.

STEP 2 — Research the reference video "${referenceVideoTitle}". Identify its HYPER-SPECIFIC subject category — not the broad genre, but the exact type of niche, obscure situation, role, or scenario it depicts.
Examples of GOOD category identification:
- "forgotten Cold War psychological warfare experiments" (not just "Cold War")
- "obscure medieval torture professions" (not just "medieval history")
- "failed early 20th century Antarctic expeditions nobody remembers" (not just "exploration")

STEP 3 — Find 25 real, OBSCURE subjects in that exact same niche category. Rules:
- MUST be genuinely obscure — most people have never heard of it
- MUST be the same specific type as the reference video (same era, tone, level of detail)
- MUST NOT appear in the blacklist above
- MUST NOT already have a major YouTube video (search to check)
- MUST be specific: include a real name, place, date, or institution
- REJECT anything that sounds like a basic school history lesson or a famous Wikipedia event
- Each written as a SHORT PHRASE (3–7 words) only

CANDIDATES:
1.
2.
(continue to 25)`
    , { temperature: 0.7 }
  );
  if (p1.error) return { error: p1.error };

  // Extract lines under the CANDIDATES: header; fall back to scanning whole response
  const p1Text = p1.text;
  const candidatesStart = p1Text.search(/^CANDIDATES:/im);
  const scanSection = candidatesStart >= 0 ? p1Text.slice(candidatesStart) : p1Text;

  const parseLine = l => l.replace(/^\d+[\.\)\-]\s*/, '').replace(/\*+/g, '').trim();
  const isHeader  = l => /^(EXISTING TITLES|CANDIDATES|STEP \d|CHANNEL|REFERENCE|ALREADY|OUTPUT)/i.test(l);
  const isBracket = l => /^\[/.test(l);
  const isShort   = l => l.length < 6;

  let candidateLines = scanSection
    .split('\n')
    .map(parseLine)
    .filter(l => !isHeader(l) && !isBracket(l) && !isShort(l) && !/^-+$/.test(l))
    .slice(0, 35);

  // Last-resort fallback: scan the entire response for numbered lines
  if (candidateLines.length < 5) {
    candidateLines = p1Text
      .split('\n')
      .map(parseLine)
      .filter(l => !isHeader(l) && !isBracket(l) && !isShort(l) && !/^-+$/.test(l))
      .slice(0, 35);
  }

  if (!candidateLines.length) return { error: 'Could not generate candidate topics. Try again.' };

  // ── Phase 2: verify each candidate with real YouTube search ─────────────
  const stopWords = new Set(['the','and','for','with','that','this','from','have','been','about','what','when','how','was','were','are','but','not','you','all','can','her','his','they','will','one','had','did','its','who','may','said','let','got','into','than','just','more','some','over','also','then','them','only','out','our','both','each','after','before','being','most','such','under','very','well','case','true','real','story','dark','truth','inside','never','told','rise','fall']);

  const keywords = c => c.toLowerCase().split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length > 3 && !stopWords.has(w));

  // Detect proper nouns: 2+ consecutive Title-Case words (e.g. "John Wayne Gacy")
  const hasProperNoun = c => /[A-Z][a-z]{1,}\s[A-Z][a-z]{1,}/.test(c);

  const isTaken = (results, candidate) => {
    if (!results.length) return false;
    if (results.length >= 5) return true;
    const kws = keywords(candidate);
    if (!kws.length) return false;
    const threshold = hasProperNoun(candidate) ? 1 : 2;
    return results.some(r => {
      const t = (r.title || '').toLowerCase();
      return kws.filter(k => t.includes(k)).length >= threshold;
    });
  };

  const isTooBasic = candidate => keywords(candidate).length < 2;

  // Verify all candidates in parallel batches of 6 — each candidate runs its 2 searches in parallel
  const BATCH = 6;
  const pool_candidates = candidateLines.filter(c => !isTooBasic(c)).slice(0, 24);
  const verifiedOriginals = [];

  for (let i = 0; i < pool_candidates.length && verifiedOriginals.length < 12; i += BATCH) {
    const batch = pool_candidates.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async candidate => {
      const coreQuery = keywords(candidate).slice(0, 4).join(' ');
      const [r1, r2] = await Promise.all([
        searchYouTube(candidate, 10),
        coreQuery ? searchYouTube(coreQuery, 10) : Promise.resolve([]),
      ]);
      const taken = isTaken(r1, candidate) || isTaken(r2, candidate);
      return taken ? null : candidate;
    }));
    for (const c of batchResults) { if (c) verifiedOriginals.push(c); }
  }

  const pool = verifiedOriginals.length >= 3
    ? verifiedOriginals
    : candidateLines.slice(0, 10); // fallback if Supadata key not set

  // ── Phase 3: score virality + write final titles ─────────────────────────
  // Detect POV-style reference video: title starts with "You", "Your", "You're"
  const isPOV = /^you[\s'r]/i.test((referenceVideoTitle || '').trim());

  const titleFormatBlock = isPOV
    ? `- TITLE FORMAT — Mix all three POV templates across the ${count} titles (reference video is POV-style):
    "Your Life as a [X]"
    "You Become [X]"
    "You're the [X]"
  Do NOT repeat the same template twice in a row.
  [X] must be ULTRA-SPECIFIC — exact role, real year/decade, exact country or institution, and the most extreme detail.
  Examples:
    ✓ "You Become the Only Surgeon on a 1986 Soviet Nuclear Submarine"
    ✓ "Your Life as a 1970s Deep-Sea Saturation Diver in the North Sea"
    ✓ "You're the Sole Psychiatrist at Guantanamo Bay in 2003"
    ✗ "You Become a Doctor" — too vague
  Aim for 8–12 words total. Every title must feel like a one-line movie pitch.`
    : `- TITLE FORMAT — Write each title in the EXACT same style as "${referenceVideoTitle}".
  Match the length, tone, capitalisation, punctuation, and energy of that title precisely.
  Make each title specific and vivid — include the real subject, era, or location.`;

  // Build the numbered output template based on count
  const topicTemplate = Array.from({ length: count }, (_, i) =>
    `TOPIC ${i + 1}: [title]\nWhy it's viral: [One sentence: specific emotional hook + demand evidence]\nGap proof: [One sentence: confirmed original]\nVirality score: [HIGH / VERY HIGH] — [one word: Curiosity / Shock / Controversy / Nostalgia / Fear / Outrage]`
  ).join('\n\n');

  const p3Prompt = `You have access to Google Search.

CHANNEL: ${channelName}
REFERENCE VIDEO: "${referenceVideoTitle}"
${existingBlock}
VERIFIED ORIGINAL TOPICS (confirmed NOT yet covered on YouTube):
${pool.map((t, i) => `${i + 1}. ${t}`).join('\n')}

These topics have been verified as ORIGINAL — no major YouTube video exists for them yet.

TASK: From the list above, pick the ${count} with the highest viral potential.

STRICT FILTERS — discard any topic that:
❌ Is too broad or generic (e.g. "Ancient Rome", "World War 2", "The Black Plague")
❌ Is already a famous Wikipedia article that most people know about
❌ Sounds like a basic school history lesson
❌ Has fewer than 2 specific details (name, year, place, institution)
❌ Has already been done as a major YouTube video

ONLY keep topics that:
✅ Are genuinely obscure — most people have NEVER heard of this specific subject
✅ Are in the EXACT same niche category as the reference video "${referenceVideoTitle}"
✅ Have a specific hook — a real name, place, year, or extreme detail that makes it feel unique
✅ Have clear audience appeal — something people would click immediately

For each surviving topic:
- Search Google Trends / Reddit / news to confirm real audience interest
${titleFormatBlock}

OUTPUT exactly ${count}:

${topicTemplate}`;

  // Prepend transcript context if available — gives Gemini the actual content to match against
  const transcriptBlock = transcriptText
    ? `\nREFERENCE VIDEO TRANSCRIPT (use this to understand the exact tone, depth, and subject matter to match):\n---\n${transcriptText.split(/\s+/).slice(0, 800).join(' ')}\n---\n`
    : '';
  const p3PromptWithTranscript = transcriptBlock + p3Prompt;

  let p3;
  if (videoUrl) {
    // Gemini natively watches the video to understand its exact style
    const SYS = `You are an expert YouTube content strategist. You will be shown a reference YouTube video. Watch it carefully — note the exact subject matter, tone, depth, specificity, and title style. Use these to judge which topics from the list best fit this channel's style.`;
    const USER = p3PromptWithTranscript + (isPOV
      ? `\n\nIMPORTANT: You have just watched the reference video. It is POV-style. Mix all three POV templates evenly. [X] must name the exact role, real year, specific country or institution, and the most extreme detail. Every title must read like a one-line movie pitch — 8 to 12 words. Vague titles are rejected.`
      : `\n\nIMPORTANT: You have just watched the reference video. Write every title in the exact same style — match the length, tone, capitalisation, and energy of the reference title precisely.`);
    p3 = await callGeminiWithVideo(videoUrl, SYS, USER);
    // Fallback to search-only if video call fails
    if (p3.error) p3 = await callGeminiWithSearch(p3PromptWithTranscript, { temperature: 0.8 });
  } else {
    p3 = await callGeminiWithSearch(p3PromptWithTranscript, { temperature: 0.7 });
  }

  const result = p3;
  if (result.error) return { error: result.error };

  const matches = [...result.text.matchAll(
    /TOPIC\s*\d+[:\.\)]\s*(.+?)[\r\n]+.*?viral[^:\r\n]*:\s*(.+?)[\r\n]+.*?[Gg]ap[^:\r\n]*:\s*(.+?)[\r\n]+.*?[Vv]irality[^:\r\n]*:\s*(.+?)(?=[\r\n]+TOPIC\s*\d|$)/gis
  )];

  if (!matches.length) {
    // Fallback: line-by-line extraction for when Gemini varies the format
    const lines = result.text.split('\n').map(l => l.trim()).filter(Boolean);
    const extracted = [];
    let cur = null;
    for (const line of lines) {
      if (/^TOPIC\s*\d+[:\.\)]/i.test(line)) {
        if (cur?.title) extracted.push(cur);
        cur = { title: line.replace(/^TOPIC\s*\d+[:\.\)]\s*/i, '').replace(/\*+/g,'').trim(), why: '', gap: '', virality: 'HIGH' };
      } else if (cur) {
        const val = line.includes(':') ? line.split(':').slice(1).join(':').trim() : '';
        if (/viral/i.test(line) && val)    cur.why      = val;
        else if (/gap/i.test(line) && val) cur.gap      = val;
        else if (/viral.*score|score/i.test(line) && val) cur.virality = val;
        else if (!cur.title && line)       cur.title    = line.replace(/\*+/g,'').trim();
      }
    }
    if (cur?.title) extracted.push(cur);
    if (extracted.length) return { topics: extracted };
    return { error: 'No topics found in response. Try again.' };
  }

  return {
    topics: matches.map(m => ({
      title:    m[1].trim(),
      why:      m[2].trim(),
      gap:      m[3].trim(),
      virality: m[4].trim(),
    }))
  };
}

function _renderTopicCards(container, topics, startIndex) {
  // Store topics by index so onclick can look them up safely (avoids quote-escaping bugs)
  topics.forEach((t, i) => { _otherTopics[startIndex + i] = t; });

  const viralityColor = v => {
    if (/very high/i.test(v)) return { bg: 'rgba(234,179,8,0.1)', border: 'rgba(234,179,8,0.3)', text: '#fcd34d' };
    return { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)', text: '#86efac' };
  };

  container.insertAdjacentHTML('beforeend', topics.map((t, i) => {
    const idx = startIndex + i;
    const num = String(idx + 1).padStart(2, '0');
    const vc  = viralityColor(t.virality);
    return `<div class="other-topic-card" onclick="selectOtherTopic(${idx})">
      <div class="other-topic-num">TOPIC ${num}</div>
      <div class="other-topic-title">${escapeHTML(t.title)}</div>
      <div class="other-topic-why">${escapeHTML(t.why)}</div>
      <div class="other-topic-gap">✓ ${escapeHTML(t.gap)}</div>
      <div class="other-topic-footer">
        <div style="padding:3px 10px;background:${vc.bg};border:1px solid ${vc.border};border-radius:20px;font-size:10px;font-weight:700;color:${vc.text};">${escapeHTML(t.virality)}</div>
        <div style="font-size:11px;font-weight:600;color:rgba(192,132,252,0.45);">Click to generate script →</div>
      </div>
    </div>`;
  }).join(''));
}

function selectOtherTopic(index) {
  const t = _otherTopics[index];
  if (!t) return;
  currentOtherTopic = t.title;

  document.querySelectorAll('.other-topic-card').forEach((el, i) => {
    el.classList.toggle('selected', i === index);
  });

  get('other-selected-topic-display').innerHTML =
    `<strong>${escapeHTML(t.title)}</strong><br><span style="font-size:11px;color:#a78bfa;">${escapeHTML(t.why)}</span>`;

  // Show script section with spinner immediately so user sees something happening
  get('other-script-section').style.display = 'block';
  get('other-script-output').style.display = 'block';
  get('other-text').innerHTML = `<div class="ccp-loading-row" style="justify-content:center;padding:32px 0;"><span class="ccp-spinner" style="width:22px;height:22px;"></span><span style="color:#6b7280;font-size:13px;">Writing script…</span></div>`;
  get('other-script-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Auto-generate the script for this topic
  generateOtherScript();
}

async function generateMoreTopicIdeas() {
  if (!currentOtherAnalysis) return showToast('Analyse a video first.', 'error');

  const btn = get('more-topics-btn');
  const statusEl = get('more-topics-status');
  btn.disabled = true;
  btn.innerHTML = '<span class="ccp-spinner" style="width:13px;height:13px;border-width:2px;"></span> Searching…';
  statusEl.style.display = 'none';

  // Extract channel info from stored analysis (same fields as analyzeReferenceVideo)
  const channelNameMatch = currentOtherAnalysis.match(/Channel name:\s*(.+)/i);
  const channelUrlMatch  = currentOtherAnalysis.match(/Channel URL:\s*(.+)/i);
  const channelNiche     = currentOtherAnalysis.match(/Niche\/category:\s*(.+)/i);
  const channelName = channelNameMatch?.[1]?.trim() || 'the reference channel';
  const channelLink = channelUrlMatch?.[1]?.trim()  || '';
  const nicheLabel  = channelNiche?.[1]?.trim()     || 'YouTube';

  // Collect already-suggested titles so we don't repeat them
  const existingTitles = Array.from(document.querySelectorAll('.other-topic-title'))
    .map(el => el.textContent.trim())
    .filter(Boolean);

  const topicResult = await _searchForTopics(channelName, channelLink, nicheLabel, currentOtherAnalysis, existingTitles, '', currentOtherVideoUrl, 8, currentOtherTranscript);

  btn.disabled = false;
  btn.textContent = '+ Generate More Topic Ideas';

  if (topicResult.error) return showToast(topicResult.error, 'error');

  const container = get('other-topic-cards');
  const startIndex = container.querySelectorAll('.other-topic-card').length;
  _renderTopicCards(container, topicResult.topics, startIndex);
  showToast(`${topicResult.topics.length} new topic ideas added.`, 'success');
}

async function generateOtherScript() {
  if (!currentOtherAnalysis) return showToast('Analyse a video first.', 'error');
  if (!currentOtherTopic)    return showToast('Select a topic first.', 'error');

  const myGen = ++_otherScriptGen;
  const btn = get('generate-other-btn');
  setLoading(btn, '⚡ Generate Script');

  const SYS = `You are an expert YouTube scriptwriter. You write original scripts that precisely mirror the structure, tone, pacing, and segment layout of reference videos — but on entirely new topics. You NEVER truncate, summarise, or use placeholders. You write every paragraph in full until you reach the required length. You do not stop until the script is complete.`;

  // Build the transcript block — use real transcript if available, else fall back to analysis
  const transcriptBlock = currentOtherTranscript
    ? `REFERENCE VIDEO TRANSCRIPT (mirror this structure and length exactly):
---
${currentOtherTranscript}
---
The transcript above is ${currentOtherTranscript.split(/\s+/).filter(Boolean).length.toLocaleString()} words. Your script must be the same length.`
    : `REFERENCE VIDEO ANALYSIS (use structure and runtime from this):
${currentOtherAnalysis}`;

  const USER = `Write a COMPLETE YouTube script on this topic: "${currentOtherTopic}"

${transcriptBlock}

ABSOLUTE LENGTH REQUIREMENTS — these override everything else:
- The script MUST contain exactly 70 paragraphs of spoken narration
- The total spoken word count MUST reach 1,900 words — do not stop before this
- Every paragraph must be 3–5 full sentences; never write a paragraph shorter than 3 sentences
- If you are approaching the end and haven't hit 70 paragraphs / 1,900 words, keep writing — do not wrap up early

STRUCTURE REQUIREMENTS:
- Follow the same segment structure as the reference: same number of named sections, same proportional timing per section
- Mirror the opening hook style, pacing rhythm, and closing CTA from the reference
- Use the same tone, voice, and sentence cadence throughout

FORMATTING — every block must use one of these markers:
  [VOICEOVER] — all spoken narration (write every sentence in full, every time)
  [ON-SCREEN TEXT] — titles, labels, callouts
  [ANIMATION NOTE] — visual/graphic description
  [TRANSITION] — scene change
  [AUDIO NOTE] — music mood

STRICT RULES:
- No placeholders like "[continued]", "[etc]", "[more here]", or "…" — write the actual words
- No summarising sections — write them out completely
- Never stop mid-script

Begin with a section summary table showing each section name and its paragraph count, then write the complete script, then end with: TOTAL SPOKEN WORDS: [number]`;

  const result = await callGemini(SYS, USER);

  // If the user clicked a different topic while this was generating, discard this result
  if (myGen !== _otherScriptGen) return;

  setLoading(btn, '⚡ Generate Script', false);
  if (result.error) {
    get('other-text').innerHTML = `<p style="color:#f87171;font-size:13px;">${escapeHTML(result.error)}</p>`;
    return;
  }

  const voiceWords = result.text.split('\n')
    .filter(l => l.trim().startsWith('[VOICEOVER]'))
    .join(' ').split(/\s+/).filter(Boolean).length;

  const blocks = result.text.split(/\n\s*\n/).filter(b => b.trim());
  get('other-text').innerHTML = blocks.map(block => {
    const t = block.trim();
    if (/^###/.test(t))             return `<p style="margin:22px 0 6px;color:#c084fc;font-size:13px;font-weight:700;">${t.replace(/^###\s*/, '')}</p>`;
    if (/^\[VOICEOVER\]/i.test(t))  return `<p style="margin:0 0 10px;color:#e8ecf6;">${t}</p>`;
    if (/^\[ANIMATION NOTE\]/i.test(t)) return `<p style="margin:0 0 8px;color:#7c6fa0;font-size:11px;font-style:italic;">${t}</p>`;
    if (/^\[ON-SCREEN TEXT\]/i.test(t)) return `<p style="margin:0 0 8px;color:#14b8a6;font-size:11px;">${t}</p>`;
    if (/^\[AUDIO NOTE\]/i.test(t)) return `<p style="margin:0 0 8px;color:#f59e0b;font-size:11px;">${t}</p>`;
    if (/^\[TRANSITION\]/i.test(t)) return `<p style="margin:0 0 12px;color:#6b7280;font-size:11px;font-style:italic;">${t}</p>`;
    return `<p style="margin:0 0 10px;color:var(--text2);">${t.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  const label = get('other-script-label');
  if (label) label.textContent = `Script — ${voiceWords.toLocaleString()} spoken words (~${Math.round(voiceWords/150)} min)`;

  show('other-script-output');
  pushToRefiner('other-text');
  markPipelineStep('other', 'script');
  showToast('Script ready — populated in Script Refiner.', 'success');
  get('other-script-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function generateOtherImages() {
  const script = get('otherimg-script').value.trim();
  const topic  = get('otherimg-topic').value.trim();
  if (!script) return showToast('Paste your refined script first.', 'error');

  const btn = get('generate-otherimg-btn');
  setLoading(btn, '🖼 Generate Image Prompts');

  // Style reference (uploaded image or URL) takes highest priority
  if (_styleReferencePromptOther) {
    const SYS_REF = _styleRefImgData
      ? `You are an expert storyboard artist generating image prompts for a YouTube video. The attached image is the STYLE REFERENCE. You are looking at it right now. Every single image prompt you write must replicate its exact visual style — the art style, colour palette, rendering technique, lighting, line weight, texture, and mood — with zero deviation.`
      : `You are an expert storyboard artist generating image prompts for a YouTube video. The user has provided a style reference. You must apply this exact visual style to every single image prompt you write — no exceptions.\n\nSTYLE REFERENCE:\n${_styleReferencePromptOther}`;

    const PROMPT_REF = _styleRefImgData
      ? `You are looking at the style reference image attached to this message. Study it carefully — note the exact art style, colour palette, rendering technique, line work, lighting, shadows, and mood.

Convert the script below into image generation prompts for the topic: ${topic || 'this video'}

Write ONE image prompt block for EVERY [VOICEOVER] paragraph in the script — one prompt per paragraph, in order. The script has 70 [VOICEOVER] paragraphs so you must output 70 prompts. Do NOT skip any paragraph. Do NOT group multiple paragraphs into one prompt.

Format each block exactly like this:
PROMPT [n]
SCRIPT: [The full [VOICEOVER] text for this paragraph]
IMAGE: [Describe the art style and visual language you see in the reference image, then describe this specific scene: composition, subjects, action, any text overlays. The entire image must look like it was made in the same style as the reference.]

Script:
${script}

Output all 70 prompts in order. End with: TOTAL PROMPTS: [n]`
      : `Convert the script below into image generation prompts for the topic: ${topic || 'this video'}

Write ONE image prompt block for EVERY [VOICEOVER] paragraph in the script — one prompt per paragraph, in order. The script has 70 [VOICEOVER] paragraphs so you must output 70 prompts. Do NOT skip any paragraph. Do NOT group multiple paragraphs into one prompt.

Format each block exactly like this:
PROMPT [n]
SCRIPT: [The full [VOICEOVER] text for this paragraph]
IMAGE: [Start with the style reference description verbatim: "${_styleReferencePromptOther.slice(0, 150)}" — then describe: composition, action, any text overlays for this specific scene.]

Script:
${script}

Output all 70 prompts in order. End with: TOTAL PROMPTS: [n]`;

    let result;
    if (_styleRefImgData) {
      // Send the actual image to Gemini so it can SEE the style while writing prompts
      const model = localStorage.getItem('model') || GEMINI_TEXT_MODEL;
      try {
        const apiResp = await _geminiFetch(model, {
            system_instruction: { parts: [{ text: SYS_REF }] },
            contents: [{ parts: [
              { inlineData: { mimeType: _styleRefImgMime, data: _styleRefImgData } },
              { text: PROMPT_REF }
            ]}],
            generationConfig: { maxOutputTokens: 32768, temperature: 0.4 }
          });
        if (!apiResp.ok) {
          const err = await apiResp.json().catch(() => ({}));
          result = { error: err?.error?.message || `HTTP ${apiResp.status}` };
        } else {
          const data = await apiResp.json();
          const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
          result = text ? { text } : { error: 'No response from Gemini.' };
        }
      } catch (e) {
        result = { error: e.message };
      }
    } else {
      result = await callGemini(SYS_REF, PROMPT_REF);
    }

    setLoading(btn, '🖼 Generate Image Prompts', false);
    if (result.error) return showToast(result.error, 'error');
    _renderOtherImagePrompts(result.text);
    return;
  }

  const vsg = currentOtherVisualStyleGuide || '';

  const extractField = (label) => {
    const m = vsg.match(new RegExp(label + '[:\\s]+([^\\n]+)', 'i'));
    return m ? m[1].trim() : '';
  };

  const artStyle      = extractField('ART STYLE');
  const colourPalette = extractField('COLOUR PALETTE');
  const charDesign    = extractField('CHARACTER DESIGN');
  const bgStyle       = extractField('BACKGROUND STYLE');
  const textOverlays  = extractField('TEXT OVERLAYS');
  const lighting      = extractField('LIGHTING');
  const mood          = extractField('MOOD');
  const pacing        = extractField('PACING');

  const recBaseMatch = vsg.match(/RECREATION PROMPT BASE[:\s]+([\s\S]+)/i);
  const recBase = recBaseMatch ? recBaseMatch[1].trim() : '';

  const SYS = vsg ? `You are an expert storyboard artist generating image prompts for a YouTube video. Gemini previously watched the reference video and extracted the following visual style guide. You must apply this style to every single image prompt you write — no exceptions.

REFERENCE VIDEO VISUAL STYLE:
- Art style: ${artStyle}
- Colour palette: ${colourPalette}
- Character design: ${charDesign}
- Background style: ${bgStyle}
- Text overlays: ${textOverlays}
- Lighting: ${lighting}
- Mood: ${mood}
- Pacing: ${pacing}

RECREATION PROMPT BASE (copy this verbatim at the start of every IMAGE prompt before the scene description):
${recBase}

RULES:
- Every IMAGE prompt MUST start with the Recreation Prompt Base above, copied word for word
- After the Recreation Prompt Base, describe the specific scene
- Colour palette must match exactly — use the specific colours listed
- Art style, character design and background style must be identical across every prompt
- Do not use generic terms like "cinematic" or "detailed" — use only the specific descriptors from the style guide above`
  : `You are an expert storyboard artist and image prompt writer. You convert completed scripts into detailed AI image generation prompts.`;

  const imagePromptInstruction = `IMAGE: ${recBase
    ? `[Copy this verbatim first: "${recBase.slice(0, 120)}..."] Then describe: composition, action, any text overlays for this specific scene. The Recreation Prompt Base must appear at the start, word for word.`
    : `[Detailed image generation prompt — include art style, colour palette, composition, lighting, and any text overlays]`}`;

  const PROMPT = `Convert the script below into image generation prompts for the topic: ${topic || 'this video'}

Write ONE image prompt block for EVERY [VOICEOVER] paragraph in the script — one prompt per paragraph, in order. The script has 70 [VOICEOVER] paragraphs so you must output 70 prompts. Do NOT skip any paragraph. Do NOT group multiple paragraphs into one prompt.

Format each block exactly like this:
PROMPT [n]
SCRIPT: [The full [VOICEOVER] text for this paragraph]
${imagePromptInstruction}

Script:
${script}

Output all 70 prompts in order. End with: TOTAL PROMPTS: [n]`;

  const result = await callGemini(SYS, PROMPT);
  setLoading(btn, '🖼 Generate Image Prompts', false);
  if (result.error) return showToast(result.error, 'error');

  _renderOtherImagePrompts(result.text);
}

function _renderOtherImagePrompts(text) {
  const blocks = text.trim().split(/\n\s*(?=PROMPT\s+\d+)/i).filter(s => s.trim());
  get('otherimg-list').innerHTML = blocks.map(block => {
    const lines = block.trim().split('\n');
    const label = lines[0].trim();
    let scriptLine = '', imageLine = '';
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (/^SCRIPT:\s*/i.test(t))     scriptLine = t.replace(/^SCRIPT:\s*/i, '');
      else if (/^IMAGE:\s*/i.test(t)) imageLine  = t.replace(/^IMAGE:\s*/i, '');
      else if (scriptLine && !imageLine) scriptLine += ' ' + t;
      else if (imageLine)              imageLine  += ' ' + t;
    }
    return `<div class="beat-item">
      <div class="beat-header">
        <span class="beat-num">${escapeHTML(label)}</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="beat-render-btn" title="Render with Nano Banana">🎨 Render</button>
          <button class="beat-copy-btn" title="Copy image prompt">📋</button>
        </div>
      </div>
      ${scriptLine ? `<div class="beat-script-line">${escapeHTML(scriptLine)}</div>` : ''}
      <div class="beat-prompt-block"><div class="beat-prompt">${escapeHTML(imageLine || lines.slice(1).join(' ').trim())}</div></div>
    </div>`;
  }).join('');

  show('otherimg-output');
  saveBeatData('other');
  markPipelineStep('other', 'images');
}

// ─── Title Ideas ──────────────────────────────────────────────────────────

// Single Gemini request — returns { text } or null
async function _geminiRequest(model, body) {
  try {
    const response = await _geminiFetch(model, body);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${response.status}`;
      console.warn('[gemini]', url.split('/').pop().split(':')[0], response.status, msg);
      return { status: response.status, msg };
    }
    const data = await response.json();
    if (data?.promptFeedback?.blockReason) return { blocked: data.promptFeedback.blockReason };
    const candidate = data?.candidates?.[0];
    if (!candidate) return null;
    const text = (candidate?.content?.parts || [])
      .filter(p => !p.thought)
      .map(p => p.text || '')
      .join('')
      .trim();
    return text ? { text } : null;
  } catch (e) {
    console.warn('[gemini] fetch error', e.message);
    return null;
  }
}

// Gemini call with Google Search grounding — tries multiple models, falls back to no-search
async function callGeminiWithSearch(userPrompt, { temperature = 1.0 } = {}) {
  const geminiKey = getGeminiKey();
  if (!hasApiAccess()) return { error: 'Add your Gemini API key in ⚙️ Settings.' };

  const MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.5-flash',
  ];

  const makeBody = (withSearch) => ({
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    ...(withSearch ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: { maxOutputTokens: 16384, temperature }
  });

  // Pass 1: with Google Search grounding
  for (const model of MODELS) {
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 4000));
      const res = await _geminiRequest(model, makeBody(true));
      if (!res) continue;
      if (res.blocked) return { error: `Blocked: ${res.blocked}` };
      if (res.text) return { text: res.text };
      if (res.status === 404 || /no longer available|new user|deprecated/i.test(res.msg || '')) break;
      if (res.status === 429 || res.status === 503) continue;
      break;
    }
  }

  // Pass 2: fallback without search grounding
  for (const model of MODELS) {
    for (let i = 0; i < 2; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 3000));
      const res = await _geminiRequest(model, makeBody(false));
      if (!res) continue;
      if (res.blocked) return { error: `Blocked: ${res.blocked}` };
      if (res.text) return { text: res.text };
      if (res.status === 404 || /no longer available|new user|deprecated/i.test(res.msg || '')) break;
      if (res.status === 429 || res.status === 503) continue;
      break;
    }
  }

  return { error: 'Gemini did not return a response. Please try again.' };
}

async function findFreshTopic(niche) {
  const btnId = `find-topic-${niche}-btn`;
  const resultId = `find-topic-${niche}-result`;
  const btn = get(btnId);
  const resultEl = get(resultId);
  setLoading(btn, '🔍 Find Fresh Topic');
  resultEl.style.display = 'none';

  const prompt = niche === 'stickman'
    ? `You have access to Google Search. Use it now — do not guess or rely on memory.

TASK: Find a video topic that has NOT been made by this YouTube channel:
- Bernardanimationofficial → search: youtube.com/@Bernardanimationofficial/videos

DO THIS IN ORDER:

SEARCH 1: Go to youtube.com/@Bernardanimationofficial/videos — read and write down at least 25 actual video titles from that channel. Look at their full catalogue.

SEARCH 2: Now look at that list. Find a specific low-status historical figure or role that:
  - Fits the channel's style: first-person POV stickman animation, brutal historical reality, "Why It Sucked To Be A [Role]" or "A Day In The Life Of A [Role]" format
  - Has NOT been covered by Bernardanimationofficial — not the exact role, not a close version of it
  - Comes from a real historical period with documented brutal conditions (not vague or generic)
  - Has genuine curiosity/shock value that would earn clicks

OUTPUT — respond in exactly this format, nothing before or after:

TITLES FOUND ON BERNARDANIMATIONOFFICIAL: [list 10–15 real titles you found]
NEW TITLE: [The video title — punchy, under 70 chars, e.g. "Why It Sucked To Be A Byzantine Tax Collector"]
TOPIC: [The specific role/figure in plain terms]
SETTING: [Historical period and place — e.g. "9th century AD, Constantinople"]
WHY IT'S MISSING: [One sentence — confirm Bernardanimationofficial has not covered this]
WHY IT WILL WORK: [One sentence — the brutality or curiosity hook]`

    : `You have access to Google Search. Use it now — do not guess or rely on memory.

TASK: Find a video topic that has NOT been made by either of these two YouTube channels:
- Last Brain Cell → search: youtube.com/@LastBrainCell videos
- 2 AM Thoughts → search: youtube.com/@official2amthoughts videos

DO THIS IN ORDER:

SEARCH 1: Go to youtube.com/@LastBrainCell/videos — read and write down at least 20 actual video titles from that channel.

SEARCH 2: Go to youtube.com/@official2amthoughts/videos — read and write down at least 20 actual video titles from that channel.

SEARCH 3: Now look at the combined list. Find a subject, question, or scenario that:
  - Fits the style and tone of these channels (curiosity-driven, philosophical, "what if", shower-thought energy, slightly unhinged but grounded)
  - Has NOT been made by either channel — not the exact topic, not even a close version of it
  - ${{ medical: 'Works as a medical curiosity video — a real or plausible medical case with a shocking physiological outcome ("A Man Ate X. This Is What Happened To His...").', history: 'Works as an animated map history video — a specific war, empire collapse, or territorial shift that is genuinely under-covered on YouTube.', geo: 'Works as a geopolitical what-if or analytical explainer — a specific scenario, country, or power dynamic that raises a real "what happens next?" question.' }[niche]}
  - Has real search demand or viral curiosity gap

OUTPUT — respond in exactly this format, nothing before or after:

TITLES FOUND ON LAST BRAIN CELL: [list 5–10 real titles you found]
TITLES FOUND ON 2 AM THOUGHTS: [list 5–10 real titles you found]
NEW TITLE: [The video title — punchy, under 70 chars, matches the channel style]
TOPIC: [The subject in plain terms]
WHY IT'S MISSING: [One sentence — confirm neither channel has covered this and why the gap exists]
WHY IT WILL WORK: [One sentence — the curiosity hook or shock angle]`;

  const result = await callGeminiWithSearch(prompt);
  setLoading(btn, '🔍 Find Fresh Topic', false);

  if (result.error) return showToast(result.error, 'error');

  const text = result.text;

  // Parse — stickman uses Bernardanimationofficial, others use LBC + 2AM
  const isStickman    = niche === 'stickman';
  const ch1TitlesMatch = isStickman
    ? text.match(/TITLES FOUND ON BERNARDANIMATIONOFFICIAL:\s*([\s\S]+?)(?=NEW TITLE:|$)/)
    : text.match(/TITLES FOUND ON LAST BRAIN CELL:\s*([\s\S]+?)(?=TITLES FOUND ON 2 AM THOUGHTS:|NEW TITLE:|$)/);
  const ch2TitlesMatch = isStickman
    ? null
    : text.match(/TITLES FOUND ON 2 AM THOUGHTS:\s*([\s\S]+?)(?=NEW TITLE:|$)/);
  const newTitleMatch  = text.match(/NEW TITLE:\s*(.+)/);
  const topicMatch     = text.match(/TOPIC:\s*(.+)/);
  const settingMatch   = text.match(/SETTING:\s*(.+)/);
  const missingMatch   = text.match(/WHY IT'S MISSING:\s*([\s\S]+?)(?=WHY IT WILL WORK:|$)/);
  const whyMatch       = text.match(/WHY IT WILL WORK:\s*([\s\S]+)/);

  const ch1Titles = ch1TitlesMatch ? ch1TitlesMatch[1].trim() : '';
  const ch2Titles = ch2TitlesMatch ? ch2TitlesMatch[1].trim() : '';
  const newTitle  = newTitleMatch  ? newTitleMatch[1].trim()  : '';
  const topic     = topicMatch     ? topicMatch[1].trim()     : '';
  const setting   = settingMatch   ? settingMatch[1].trim()   : '';
  const missing   = missingMatch   ? missingMatch[1].trim().replace(/\n/g,' ') : '';
  const why       = whyMatch       ? whyMatch[1].trim().replace(/\n/g,' ')     : '';

  // Fill the relevant input field(s)
  if (niche === 'stickman') {
    if (topic)    get('prompt-role').value    = topic;
    if (setting)  get('prompt-setting').value = setting;
  } else if (niche === 'medical') {
    if (newTitle) get('medical-title').value  = newTitle;
  } else if (niche === 'history') {
    if (topic)    get('history-topic').value  = topic;
  } else if (niche === 'geo') {
    if (newTitle) get('geo-topic').value      = newTitle;
  }

  const displayTitle = newTitle || topic;
  const ch1Label = isStickman ? 'Bernardanimationofficial titles found:' : 'Last Brain Cell titles found:';

  // Show inline result card
  resultEl.innerHTML = `
    <div style="font-weight:700;font-size:13px;color:#f8f8f8;margin-bottom:8px;">✅ Topic loaded into the field above</div>
    ${displayTitle ? `<div style="color:#c084fc;font-weight:600;margin-bottom:8px;">💡 ${escapeHTML(displayTitle)}</div>` : ''}
    ${missing ? `<div style="color:#6ee7b7;margin-bottom:6px;font-size:12px;"><span style="color:#aaa;font-weight:600;">Gap: </span>${escapeHTML(missing)}</div>` : ''}
    ${why     ? `<div style="color:#aaa;font-size:12px;margin-bottom:8px;">${escapeHTML(why)}</div>` : ''}
    ${ch1Titles || ch2Titles ? `<details style="margin-top:6px;"><summary style="color:#555;font-size:11px;cursor:pointer;">Show channel research</summary>
      ${ch1Titles ? `<div style="margin-top:8px;font-size:11px;color:#666;"><div style="color:#888;font-weight:600;margin-bottom:4px;">${ch1Label}</div>${escapeHTML(ch1Titles)}</div>` : ''}
      ${ch2Titles ? `<div style="margin-top:8px;font-size:11px;color:#666;"><div style="color:#888;font-weight:600;margin-bottom:4px;">2 AM Thoughts titles found:</div>${escapeHTML(ch2Titles)}</div>` : ''}
    </details>` : ''}
  `;
  resultEl.style.display = 'block';
}

// ─── Veo 3 ────────────────────────────────────────────────────────────────
async function generateVeo3Prompts() {
  const items = Array.from(document.querySelectorAll('.beat-item'));
  if (!items.length) return showToast('Plan visual beats first.', 'error');

  const style = getActiveImageStyle();
  const btn = get('generate-veo3-btn');

  const beatsText = items.map((item, i) => {
    const scriptLine = item.querySelector('.beat-script-line')?.textContent?.trim() || '';
    const prompt = item.querySelector('.beat-prompt')?.textContent?.trim() || '';
    return `Beat ${i + 1}\nSCRIPT: ${scriptLine}\nIMAGE: ${prompt}`;
  }).join('\n\n');

  // Build style context from the visual style guide when available
  const _extractStyleField = (guide, field) => {
    const m = guide.match(new RegExp(`${field}[:\\s]+([^\\n]+)`, 'i'));
    return m ? m[1].trim() : '';
  };

  let styleSystemAddendum = '';
  let styleInstruction = `- Keep the visual style: ${style}`;

  if (currentOtherVisualStyleGuide) {
    const artStyle       = _extractStyleField(currentOtherVisualStyleGuide, 'ART STYLE');
    const colourPalette  = _extractStyleField(currentOtherVisualStyleGuide, 'COLOUR PALETTE');
    const mood           = _extractStyleField(currentOtherVisualStyleGuide, 'MOOD');
    const pacing         = _extractStyleField(currentOtherVisualStyleGuide, 'PACING');
    const cameraMovement = _extractStyleField(currentOtherVisualStyleGuide, 'CAMERA MOVEMENT');
    const transition     = _extractStyleField(currentOtherVisualStyleGuide, 'TRANSITION STYLE');

    const styleFields = [
      artStyle       && `Art style: ${artStyle}`,
      colourPalette  && `Colour palette: ${colourPalette}`,
      mood           && `Mood: ${mood}`,
      pacing         && `Pacing: ${pacing}`,
      cameraMovement && `Camera movement: ${cameraMovement}`,
      transition     && `Transitions: ${transition}`,
    ].filter(Boolean).join('\n');

    styleSystemAddendum = `\n\nThe reference video has this exact visual style — every prompt must match it:\n${styleFields}`;
    styleInstruction = `- Match the reference video style exactly:\n${styleFields.split('\n').map(l => `  ${l}`).join('\n')}\n- Camera movements must match the CAMERA MOVEMENT and TRANSITION STYLE from the reference video style guide.\n- Mood and atmosphere must match the MOOD field exactly.`;
  }

  const SYSTEM = `You are a motion prompt writer for Google Veo 3, an image-to-video AI model. Write concise, vivid motion prompts that animate static images.${styleSystemAddendum}`;
  const userPrompt = `Write a Veo 3 image-to-video motion prompt for each beat below.

Each prompt must:
- Start with "Starting from the image,"
- Describe specific natural motion matching the script emotion and action
- Include one camera movement (e.g. slow push in, gentle pan left, hold static, subtle drift, tilt up)
- Be 2–3 sentences max
${styleInstruction}
- Be optimised for 5–8 second clips

Output format — blank line between each block, no extra commentary:

VEO3 PROMPT 1
[prompt]

VEO3 PROMPT 2
[prompt]

Beats:
${beatsText}`;

  setLoading(btn, '⏳ Generating…', true);
  get('veo3-prompts-list').innerHTML = '';
  get('copy-all-veo3-btn').style.display = 'none';

  const result = await callGemini(SYSTEM, userPrompt);

  setLoading(btn, '🎬 Generate Veo 3 Prompts', false);
  if (result.error) return showToast(result.error, 'error');

  renderVeo3Output(result.text, items);
  get('copy-all-veo3-btn').style.display = '';
  markPipelineStep(currentNiche, 'veo3');
}

function renderVeo3Output(text, beatItems) {
  const blocks = text.trim().split(/\n\s*(?=VEO3 PROMPT\s+\d+)/i).filter(s => s.trim());
  const list = get('veo3-prompts-list');
  list.innerHTML = '';

  blocks.forEach((block, i) => {
    const lines = block.trim().split('\n');
    const label = lines[0].trim();
    const promptText = lines.slice(1).join(' ').trim();
    const imgSrc = beatItems[i]?.querySelector('.beat-image')?.src || null;

    const item = document.createElement('div');
    item.className = 'veo3-item';
    item.innerHTML = `
      <div class="veo3-header">
        <span class="veo3-num">${escapeHTML(label)}</span>
        <button class="veo3-copy-btn" title="Copy prompt">📋</button>
      </div>
      ${imgSrc ? `<img src="${imgSrc}" class="veo3-thumb" alt="Beat image" />` : ''}
      <div class="veo3-prompt">${escapeHTML(promptText)}</div>
    `;
    list.appendChild(item);
  });
  saveVeo3Prompts(currentNiche);
}

function copyAllVeo3() {
  const items = document.querySelectorAll('.veo3-item');
  if (!items.length) return;
  const text = Array.from(items).map((el, i) => {
    const prompt = el.querySelector('.veo3-prompt')?.textContent || '';
    return `Veo 3 Prompt ${i + 1}:\n${prompt}`;
  }).join('\n\n');
  copyText(text);
}

// ─── Voice / TTS ──────────────────────────────────────────────────────────
async function generateTTS() {
  const text  = get('tts-input').value.trim();
  const voice = get('tts-voice').value;
  if (!text) return showToast('Please paste some script text.', 'error');
  if (!hasApiAccess()) return showToast('Add your Gemini API key in ⚙️ Settings.', 'error');

  const btn = get('generate-tts-btn');
  get('tts-output').style.display = 'none';

  const cleanText = text
    .replace(/\[VISUAL:[^\]]*\]/gi, '')
    .replace(/\[MUSIC:[^\]]*\]/gi, '')
    .replace(/\[[^\]]{0,80}\]/g, '')
    .replace(/\n{2,}/g, ' ... ')
    .replace(/—/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const CHUNK_WORDS = 600;
  const sentences = cleanText.match(/[^.!?]+[.!?]+["']?\s*/g) || [cleanText];
  const chunks = [];
  let current = '';
  let wordCount = 0;
  for (const sentence of sentences) {
    const wc = sentence.trim().split(/\s+/).length;
    if (wordCount + wc > CHUNK_WORDS && current) {
      chunks.push(current.trim());
      current = sentence;
      wordCount = wc;
    } else {
      current += sentence;
      wordCount += wc;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const allPcmArrays = [];
  let sampleRate = 24000;

  for (let i = 0; i < chunks.length; i++) {
    btn.disabled = true;
    btn.textContent = chunks.length > 1 ? `⏳ Part ${i + 1} of ${chunks.length}…` : '⏳ Working…';

    const result = await geminiTTS({ text: chunks[i], voice });

    if (!result || result.error) {
      setLoading(btn, '🔊 Generate Audio', false);
      return showToast(result?.error || 'No response. Please try again.', 'error');
    }

    sampleRate = parseInt(result.mimeType?.match(/rate=(\d+)/)?.[1] || '24000');
    for (const b64 of result.audioParts) allPcmArrays.push(base64ToBytes(b64));
  }

  setLoading(btn, '🔊 Generate Audio', false);

  const totalLen = allPcmArrays.reduce((s, a) => s + a.length, 0);
  const pcmBytes = new Uint8Array(totalLen);
  let off = 0;
  for (const arr of allPcmArrays) { pcmBytes.set(arr, off); off += arr.length; }

  const wavBytes = pcmToWav(pcmBytes, sampleRate, 1, 16);
  const blob = new Blob([wavBytes], { type: 'audio/wav' });
  const url  = URL.createObjectURL(blob);

  get('tts-player').src = url;
  get('tts-output').style.display = 'block';
  markPipelineStep(currentNiche, 'voice');

  const filename = `narration-${voice.toLowerCase()}.wav`;
  localStorage.setItem('lastVoiceFile', filename);
  get('tts-download-btn').onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pcmToWav(pcm, sampleRate, channels, bitDepth) {
  const byteRate   = sampleRate * channels * bitDepth / 8;
  const blockAlign = channels * bitDepth / 8;
  const buf  = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buf);
  const write = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  write(36, 'data');
  view.setUint32(40, pcm.length, true);
  new Uint8Array(buf).set(pcm, 44);
  return new Uint8Array(buf);
}

// ─── Projects ─────────────────────────────────────────────────────────────
function saveNewProject() {
  const title = get('project-title').value.trim();
  const notes = get('project-notes').value.trim();
  if (!title) return showToast('Please enter a project title.', 'error');

  const project = { id: Date.now(), title, notes, createdAt: new Date().toISOString() };
  const projects = getProjects();
  projects.push(project);
  setProjects(projects);

  get('project-title').value = '';
  get('project-notes').value = '';
  hideForm('new-project-form');
  loadProjects();
  showToast('Project saved!', 'success');
}

function deleteProject(id) {
  setProjects(getProjects().filter(p => p.id !== id));
  loadProjects();
}

function loadProjects() {
  const projects = getProjects();
  const list = get('projects-list');
  if (!projects.length) {
    list.innerHTML = '<p class="ccp-hint">No projects yet. Create your first one!</p>';
    return;
  }
  list.innerHTML = [...projects].reverse().map(p => `
    <div class="project-item">
      <div class="project-info">
        <strong>${escapeHTML(p.title)}</strong>
        <small>${new Date(p.createdAt).toLocaleDateString()}</small>
        ${p.notes ? `<p class="project-notes-preview">${escapeHTML(p.notes.slice(0, 80))}${p.notes.length > 80 ? '…' : ''}</p>` : ''}
      </div>
      <button class="project-delete" data-id="${p.id}" title="Delete">🗑</button>
    </div>
  `).join('');
}

function savePromptToProject() {
  const text = get('prompt-text').textContent;
  if (!text) return;
  const project = {
    id: Date.now(),
    title: `Prompt – ${new Date().toLocaleString()}`,
    notes: text,
    createdAt: new Date().toISOString()
  };
  const projects = getProjects();
  projects.push(project);
  setProjects(projects);
  loadProjects();
  clearAutosaveDirty('prompt');
  showToast('Prompt saved to Projects!', 'success');
}

// ─── Settings ─────────────────────────────────────────────────────────────
function saveGeminiKey() {
  const key = get('gemini-key-input').value.trim();
  if (!key) return setStatus('gemini-key-status', '⚠ Enter your Google AI Studio key.', 'error');
  localStorage.setItem('geminiKey', key);
  setStatus('gemini-key-status', '✅ Key saved', 'success');
}

function saveSupadataKey() {
  const key = get('supadata-key-input').value.trim();
  if (!key) return setStatus('supadata-key-status', '⚠ Enter your Supadata key.', 'error');
  localStorage.setItem('supadataKey', key);
  setStatus('supadata-key-status', '✅ Key saved', 'success');
}

function saveModel() {
  const model = get('model-select').value;
  localStorage.setItem('model', model);
  setStatus('model-status', `✅ Model set to ${model}`, 'success');
}

function restoreSettings() {
  const geminiKey   = localStorage.getItem('geminiKey');
  const supadataKey = localStorage.getItem('supadataKey');
  const model       = localStorage.getItem('model');

  if (geminiKey) {
    const input = get('gemini-key-input');
    if (input) input.value = geminiKey;
    const el = get('gemini-key-status');
    if (el) el.innerHTML = `<span class="status-success">✅ Key active</span>`;
  }
  if (supadataKey) {
    const input = get('supadata-key-input');
    if (input) input.value = supadataKey;
    const el = get('supadata-key-status');
    if (el) el.innerHTML = `<span class="status-success">✅ Key active</span>`;
  }
  if (model) {
    const sel = get('model-select');
    if (sel) sel.value = model;
  }

  // Only prompt for API key on local dev — on deployed site the proxy handles it
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:';
  if (isLocal && !localStorage.getItem('geminiKey')) {
    showToast('Add your Gemini API key in ⚙️ Settings to get started.', 'error');
    setTimeout(() => switchTab('settings'), 800);
  }
}

// ─── Video Compiler ───────────────────────────────────────────────────────

function _cstepSet(id, state, subText) {
  const dot = document.querySelector(`#cstep-${id} .cstep-dot`);
  if (dot) dot.className = `cstep-dot ${state}`;
  const sub = get(`cstep-${id}-sub`);
  if (sub && subText !== undefined) sub.textContent = subText;
}

async function runVideoCompiler() {
  const videoUrl = get('compiler-url').value.trim();
  const script   = get('compiler-script').value.trim();
  const voice    = get('compiler-voice').value;
  const wps      = parseFloat(get('compiler-wps').value) || 2.5;

  if (!videoUrl && !_styleRefImgData) return showToast('Paste a reference video URL or upload a style reference image first.', 'error');
  if (!script)   return showToast('Paste your finished script first.', 'error');
  if (!hasApiAccess()) return showToast('Add your Gemini API key in Settings.', 'error');

  _compilerSegments   = [];
  _compilerStyleGuide = '';
  _compilerWavBlob    = null;

  const btn = get('run-compiler-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Compiling…';

  get('compiler-progress').style.display = 'block';
  get('compiler-results').style.display  = 'none';
  get('compiler-progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
  ['style','segment','images','video','tts','package'].forEach(s => _cstepSet(s, 'pending', 'Waiting…'));

  // ── Step 1: Style extraction ───────────────────────────────────────────
  const _styleExtractSYS = 'You are a creative director specialising in YouTube animation. You analyse references and produce precise, replicable animation style guides that can be used to recreate the exact visual look of every frame.';
  const _styleExtractUSER = `Analyse this reference carefully.

Extract an ANIMATION STYLE GUIDE in exactly this format:

ART STYLE: [e.g. flat 2D vector / 3D animation / motion graphics / live action + graphics]
COLOUR PALETTE: [list dominant colours with descriptions, e.g. "deep navy #1a1a2e, bright red #e94560, white text on dark"]
CHARACTER DESIGN: [e.g. simple black silhouettes / no faces / detailed cartoon characters / stick figures]
BACKGROUND STYLE: [e.g. solid dark colour / illustrated environments / real photos / gradient washes]
TEXT OVERLAYS: [font style, placement, colour, size, how frequently they appear]
CAMERA MOVEMENT: [e.g. slow zoom in / static wide / pan left-right / pull back reveal]
TRANSITION STYLE: [e.g. hard cut / fade to black between segments / whip pan / slide wipe]
LIGHTING: [e.g. high contrast dramatic / flat even / glowing neon accents / cinematic dark]
MOOD: [e.g. ominous and tense / upbeat educational / cinematic epic / clinical and cold]
PACING: [e.g. new visual every 4-6 seconds / holds on image during narration / rapid cuts every 2s]

RECREATION PROMPT BASE: [Write a single reusable image generation prompt — 3 to 5 sentences — that captures ALL of the above. This will be prepended to every scene description to guarantee every frame looks like it came from the same video. Be highly specific about colours, art style, rendering technique, and mood.]`;

  let styleResult;
  if (_styleRefImgData) {
    // Use uploaded style reference image instead of video URL
    _cstepSet('style', 'running', 'Scanning style image…');
    const model = localStorage.getItem('model') || GEMINI_TEXT_MODEL;
    try {
      const apiResp = await _geminiFetch(model, {
          system_instruction: { parts: [{ text: _styleExtractSYS }] },
          contents: [{ parts: [
            { inlineData: { mimeType: _styleRefImgMime, data: _styleRefImgData } },
            { text: _styleExtractUSER }
          ]}],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.3 }
        });
      if (!apiResp.ok) {
        const err = await apiResp.json().catch(() => ({}));
        styleResult = { error: err?.error?.message || `HTTP ${apiResp.status}` };
      } else {
        const data = await apiResp.json();
        const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
        styleResult = text ? { text } : { error: 'No style extracted from image.' };
      }
    } catch (e) {
      styleResult = { error: e.message };
    }
  } else {
    _cstepSet('style', 'running', 'Watching video…');
    styleResult = await callGeminiWithVideo(videoUrl, _styleExtractSYS, _styleExtractUSER);
  }

  if (styleResult.error) {
    _cstepSet('style', 'error', styleResult.error);
    btn.disabled = false; btn.textContent = '▶ Run Full Compiler';
    return showToast('Style extraction failed.', 'error');
  }
  _compilerStyleGuide = styleResult.text;
  currentOtherVisualStyleGuide = styleResult.text;
  const baseMatch  = styleResult.text.match(/RECREATION PROMPT BASE[:\s]+(.+)/i);
  const stylePrefix = baseMatch ? baseMatch[1].trim() : '';
  _cstepSet('style', 'done', 'Style extracted');

  // ── Step 2: Script segmentation via Gemini ────────────────────────────
  _cstepSet('segment', 'running', 'Analysing script…');
  let segments = await _compilerSegmentWithGemini(script, stylePrefix, wps);
  if (!segments.length) {
    // Fallback to pure-JS parser if Gemini fails or script has no markers
    segments = _compilerParseSegments(script, stylePrefix, wps);
  }
  if (!segments.length) {
    _cstepSet('segment', 'error', 'No segments found. Add [VOICEOVER] and [ANIMATION NOTE] markers to your script.');
    btn.disabled = false; btn.textContent = '▶ Run Full Compiler';
    return showToast('Add [VOICEOVER] and [ANIMATION NOTE] markers to your script first.', 'error');
  }
  _compilerSegments = segments;
  const totalDur = segments.reduce((s, seg) => s + seg.duration, 0);
  _cstepSet('segment', 'done', `${segments.length} segments · ${Math.round(totalDur)}s total`);

  // Show results section and render segment cards immediately
  get('compiler-style-output').textContent = _compilerStyleGuide;
  _compilerRenderSegmentList(segments);
  get('compiler-results').style.display = 'block';

  // ── Step 3: Images — pull from DOM / localStorage, generate only what's missing ──
  _cstepSet('images', 'running', `Processing 0 / ${segments.length}…`);

  // Collect already-rendered images from Image Planner DOM (most current source)
  const _domImages = [];
  document.querySelectorAll('.beat-image').forEach(img => {
    if (img.src && img.src.startsWith('data:')) {
      const comma = img.src.indexOf(',');
      const mime  = img.src.slice(5, img.src.indexOf(';')) || 'image/png';
      _domImages.push({ data: img.src.slice(comma + 1), mime });
    }
  });

  // Collect Veo 3 prompts from DOM (most current source)
  const _domVeo3 = [];
  document.querySelectorAll('.veo3-prompt').forEach(el => {
    _domVeo3.push(el.textContent.trim());
  });

  // Fallback to localStorage if DOM is empty (e.g. user navigated away)
  const _lsImages = _domImages.length ? null : getBeatImages(currentNiche || 'other');
  const _lsVeo3   = _domVeo3.length   ? null : getVeo3Prompts(currentNiche || 'other');

  // Assign Veo 3 prompts to segments
  for (let i = 0; i < segments.length; i++) {
    const v3 = _domVeo3[i] || _lsVeo3?.[i]?.text || '';
    if (v3) segments[i].veo3Motion = v3;
  }

  let imgDone = 0, imgFlagged = 0, imgReused = 0;
  for (let _si = 0; _si < segments.length; _si++) {
    const seg = segments[_si];
    _cstepSet('images', 'running', `Processing ${_si + 1} / ${segments.length}…`);

    // Try DOM image first, then localStorage fallback
    const domImg = _domImages[_si];
    const lsImg  = _lsImages ? _lsImages[_si + 1] : null;
    if (domImg?.data || lsImg?.data) {
      const src = domImg || lsImg;
      seg.imageData   = src.data;
      seg.imageMime   = src.mime || 'image/png';
      seg.imageError  = null;
      seg.imageReused = true;
      imgReused++;
      imgDone++;
      _compilerUpdateSegmentImage(seg);
      continue;
    }

    // No pre-existing image — generate one
    let r = await nanoBananaRender({ prompt: seg.imagePrompt });

    if (!r.error && r.imageData) {
      _cstepSet('images', 'running', `Verifying scene ${seg.id}…`);
      const check = await _compilerVerifyImage(r.imageData, r.mimeType, _compilerStyleGuide, seg.animNote);
      if (!check.pass && check.correctedPrompt) {
        imgFlagged++;
        seg.imageFlagged = true;
        seg.flagReason   = check.reason || 'Style deviation detected';
        _cstepSet('images', 'running', `Correcting scene ${seg.id}…`);
        const r2 = await nanoBananaRender({ prompt: check.correctedPrompt });
        if (!r2.error && r2.imageData) {
          r = r2;
          seg.imageCorrected  = true;
          seg.correctedPrompt = check.correctedPrompt;
        }
      }
    }

    seg.imageData  = r.imageData || null;
    seg.imageMime  = r.mimeType  || 'image/png';
    seg.imageError = r.error     || null;
    imgDone++;
    _compilerUpdateSegmentImage(seg);
  }
  const reuseNote = imgReused ? ` · ${imgReused} from Image Planner` : '';
  const flagNote  = imgFlagged ? ` · ${imgFlagged} corrected` : '';
  _cstepSet('images', 'done', `${imgDone} images ready${reuseNote}${flagNote}`);

  // ── Step 3.5: Veo 3 video clip generation ────────────────────────────
  _cstepSet('video', 'running', `Generating video clips…`);
  let videosDone = 0, videosSkipped = 0;
  const _veoApiKey = await _getApiKey();
  for (let _vi = 0; _vi < segments.length; _vi++) {
    const seg = segments[_vi];
    if (!seg.imageData) { videosSkipped++; continue; }
    _cstepSet('video', 'running', `Generating clip ${_vi + 1} / ${segments.length}…`);
    try {
      const veoEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:generateContent?key=${_veoApiKey}`;
      const veoRes = await fetch(veoEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inlineData: { mimeType: seg.imageMime, data: seg.imageData } },
            { text: seg.veo3Motion || 'Slow cinematic motion, subtle camera movement' }
          ]}],
          generationConfig: { durationSeconds: Math.min(Math.round(seg.duration), 8) }
        })
      });
      const veoData = await veoRes.json();
      const videoPart = veoData?.candidates?.[0]?.content?.parts?.[0];
      const videoBytes = videoPart?.fileData || videoPart?.inlineData;
      if (videoBytes?.data) {
        seg.videoData = videoBytes.data;
        seg.videoMime = videoBytes.mimeType || 'video/mp4';
        videosDone++;
      } else {
        videosSkipped++;
      }
    } catch (e) {
      seg.videoError = e.message;
      videosSkipped++;
    }
  }
  if (videosDone > 0) {
    _cstepSet('video', 'done', `${videosDone} clips generated · ${videosSkipped} used still image`);
  } else {
    _cstepSet('video', 'done', `No clips generated — still images will be used with Ken Burns zoom`);
  }

  // ── Step 4: TTS narration ─────────────────────────────────────────────
  _cstepSet('tts', 'running', 'Generating narration…');
  const voiceoverText = segments.map(s => s.voiceover).filter(Boolean).join('\n\n');
  const ttsResult = await _compilerRunTTS(voiceoverText, voice);
  if (ttsResult.error) {
    _cstepSet('tts', 'error', ttsResult.error);
  } else {
    _compilerWavBlob = ttsResult.blob;
    get('compiler-audio').src = URL.createObjectURL(ttsResult.blob);
    _cstepSet('tts', 'done', 'Narration ready');
  }

  // ── Step 5: Build package ─────────────────────────────────────────────
  _cstepSet('package', 'running', 'Building package…');
  const videoTitle  = get('compiler-title').value.trim() || 'Untitled Video';
  const ffmpegCmd   = _compilerBuildFFmpegCmd(voice, segments);
  const filelistTxt = _compilerBuildFileList(segments);
  get('compiler-ffmpeg-cmd').value = ffmpegCmd;
  get('compiler-download-btn').onclick = () => _compilerDownloadZip(segments, videoTitle, ffmpegCmd, filelistTxt, voice);
  get('compiler-copy-ffmpeg-btn').onclick = () => { copyText(ffmpegCmd); showToast('FFmpeg command copied!'); };
  _cstepSet('package', 'done', 'Package ready — download below');

  btn.disabled = false;
  btn.textContent = '▶ Run Full Compiler';
  get('compiler-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('Compilation complete!', 'success');
}

async function _compilerSegmentWithGemini(script, stylePrefix, wps) {
  const SYS = `You are a professional video editor. You read YouTube scripts and break them into precise timed segments for video production. You output clean, structured data with no deviation from the requested format.`;

  const USER = `You are a video editor. I have this script:

${script}

Break it into segments. For each [ANIMATION NOTE] or scene change, output exactly:

SEGMENT [n]
VOICEOVER: [exact words spoken in this segment]
WORD COUNT: [n]
DURATION: [word count ÷ ${wps}, rounded to nearest 0.5s] seconds
B-ROLL DESCRIPTION: [what should be visually on screen]
IMAGE PROMPT: ${stylePrefix ? stylePrefix + ' ' : ''}[specific scene description for this segment — describe the exact visual composition, subjects, colours, and atmosphere]
VEO 3 MOTION: [camera movement and animation instruction for this exact image — e.g. "slow zoom in on the figure", "pan left revealing the landscape", "static shot with dust particles floating"]

End with:
TOTAL DURATION: [sum of all durations] seconds
TOTAL SEGMENTS: [n]
TOTAL NARRATION WORD COUNT: [n]`;

  const result = await callGemini(SYS, USER);
  if (result.error) return [];

  const segments = [];
  const blocks = result.text.split(/\n(?=SEGMENT\s+\d+)/i).filter(b => /^SEGMENT\s+\d+/i.test(b.trim()));

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const seg = { id: 0, voiceover: '', words: 0, duration: 0, animNote: '', imagePrompt: '', veo3Motion: '', imageData: null, imageMime: 'image/png', imageError: null };

    const idMatch = lines[0].match(/SEGMENT\s+(\d+)/i);
    if (idMatch) seg.id = parseInt(idMatch[1]);

    for (const line of lines.slice(1)) {
      if (/^VOICEOVER:/i.test(line))        seg.voiceover   = line.replace(/^VOICEOVER:\s*/i, '').trim();
      else if (/^WORD COUNT:/i.test(line))   seg.words       = parseInt(line.replace(/^WORD COUNT:\s*/i, '')) || 0;
      else if (/^DURATION:/i.test(line))     seg.duration    = parseFloat(line.replace(/^DURATION:\s*/i, '')) || 2;
      else if (/^B-ROLL/i.test(line))        seg.animNote    = line.replace(/^B-ROLL DESCRIPTION:\s*/i, '').trim();
      else if (/^IMAGE PROMPT:/i.test(line)) seg.imagePrompt = line.replace(/^IMAGE PROMPT:\s*/i, '').trim();
      else if (/^VEO 3 MOTION:/i.test(line)) seg.veo3Motion  = line.replace(/^VEO 3 MOTION:\s*/i, '').trim();
    }

    if (!seg.words && seg.voiceover) seg.words = seg.voiceover.split(/\s+/).filter(Boolean).length;
    if (!seg.duration) seg.duration = Math.max(2, Math.round((seg.words / wps) * 10) / 10);
    if (!seg.imagePrompt && stylePrefix) seg.imagePrompt = `${stylePrefix} ${seg.animNote}`.trim();
    if (seg.id > 0) segments.push(seg);
  }

  return segments;
}

function _compilerParseSegments(script, stylePrefix, wps) {
  const lines = script.split('\n').map(l => l.trim()).filter(Boolean);
  const segments = [];
  let currentVO = '';
  let idx = 0;

  for (const line of lines) {
    if (/^\[VOICEOVER\]/i.test(line)) {
      const text = line.replace(/^\[VOICEOVER\]\s*/i, '').trim();
      currentVO += (currentVO ? ' ' : '') + text;
    } else if (/^\[ANIMATION NOTE\]/i.test(line)) {
      const animDesc = line.replace(/^\[ANIMATION NOTE\]\s*/i, '').trim();
      const words    = currentVO ? currentVO.split(/\s+/).filter(Boolean).length : 0;
      const duration = Math.max(2, Math.round((words / wps) * 10) / 10);
      segments.push({
        id: ++idx, voiceover: currentVO.trim(), words, duration, animNote: animDesc,
        imagePrompt: stylePrefix ? `${stylePrefix}. Scene: ${animDesc}` : animDesc,
        imageData: null, imageMime: 'image/png', imageError: null,
      });
      currentVO = '';
    }
  }
  // Remaining voiceover with no animation note
  if (currentVO.trim()) {
    const words    = currentVO.split(/\s+/).filter(Boolean).length;
    const duration = Math.max(2, Math.round((words / wps) * 10) / 10);
    segments.push({
      id: ++idx, voiceover: currentVO.trim(), words, duration, animNote: 'Closing scene',
      imagePrompt: stylePrefix ? `${stylePrefix}. Closing scene.` : 'Closing scene.',
      imageData: null, imageMime: 'image/png', imageError: null,
    });
  }
  return segments;
}

function _compilerRenderSegmentList(segments) {
  const totalDur   = segments.reduce((s, seg) => s + seg.duration, 0);
  const totalWords = segments.reduce((s, seg) => s + (seg.words || 0), 0);
  get('compiler-segments-list').innerHTML =
    `<div class="cseg-summary">
       <span>${segments.length} segments</span>
       <span>${Math.round(totalDur)}s total · ~${Math.round(totalDur / 60 * 10) / 10} min</span>
       <span>${totalWords.toLocaleString()} spoken words</span>
     </div>` +
    segments.map(seg => `
    <div class="compiler-seg" id="cseg-${seg.id}">
      <div class="cseg-header">
        <span class="cseg-num">SCENE ${String(seg.id).padStart(2,'0')}</span>
        <span class="cseg-timing">${seg.duration}s &nbsp;·&nbsp; ${seg.words} words</span>
      </div>
      <div class="cseg-body">
        <div class="cseg-image-wrap" id="cseg-img-${seg.id}">
          <div class="cseg-placeholder"><span class="ccp-spinner" style="width:16px;height:16px;"></span></div>
        </div>
        <div class="cseg-text">
          <div class="cseg-voiceover">${escapeHTML(seg.voiceover || '—')}</div>
          <div class="cseg-anim">🎬 ${escapeHTML(seg.animNote || seg.imagePrompt || '')}</div>
          ${seg.veo3Motion ? `<div class="cseg-veo3">📷 ${escapeHTML(seg.veo3Motion)}</div>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function _compilerUpdateSegmentImage(seg) {
  const wrap = get(`cseg-img-${seg.id}`);
  if (!wrap) return;
  const filename = `scene_${String(seg.id).padStart(2,'0')}_${seg.duration}s.png`;
  if (seg.imageError) {
    wrap.innerHTML = `<div class="cseg-img-error">❌ ${escapeHTML(seg.imageError)}</div>`;
  } else if (seg.imageData) {
    const badge = seg.imageCorrected
      ? `<span class="cseg-badge corrected" title="${escapeHTML(seg.flagReason || '')}">✦ corrected</span>`
      : seg.imageFlagged
        ? `<span class="cseg-badge flagged" title="${escapeHTML(seg.flagReason || '')}">⚠ flagged</span>`
        : `<span class="cseg-badge ok">✓</span>`;
    wrap.innerHTML = `
      <img class="cseg-img" src="data:${seg.imageMime};base64,${seg.imageData}" alt="Scene ${seg.id}" />
      ${badge}
      <a class="cseg-dl" href="data:${seg.imageMime};base64,${seg.imageData}" download="${filename}">⬇</a>`;
  }
}

async function _compilerVerifyImage(imageData, mimeType, styleGuide, sceneDesc) {
  const model = localStorage.getItem('model') || GEMINI_TEXT_MODEL;

  const prompt = `You are a creative director QA-checking AI-generated images for a YouTube video.

STYLE GUIDE:
${styleGuide}

SCENE DESCRIPTION: ${sceneDesc}

Look at the attached image. Check it against each item in the style guide:
✓ Colour palette from style guide
✓ Art style and rendering technique
✓ Text overlay style (if applicable)
✓ Mood and atmosphere
✓ Character design consistency

OUTPUT exactly:
PASS: [YES or NO]
DEVIATIONS: [list any deviations, or "None"]
CORRECTED PROMPT: [If PASS is NO — write a new, highly specific image generation prompt that fixes all deviations while keeping the same scene. If PASS is YES — write "N/A"]`;

  try {
    const response = await _geminiFetch(model, {
        contents: [{ parts: [
          { inlineData: { mimeType, data: imageData } },
          { text: prompt }
        ]}],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.2 }
      });
    if (!response.ok) return { pass: true }; // on API error, skip and move on
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const passMatch      = text.match(/PASS:\s*(YES|NO)/i);
    const deviations     = text.match(/DEVIATIONS:\s*(.+?)(?=\nCORRECTED PROMPT:|$)/is)?.[1]?.trim() || '';
    const correctedMatch = text.match(/CORRECTED PROMPT:\s*(.+?)$/is)?.[1]?.trim() || '';

    const pass = passMatch?.[1]?.toUpperCase() === 'YES';
    return {
      pass,
      reason:          pass ? '' : deviations,
      correctedPrompt: pass || correctedMatch === 'N/A' ? null : correctedMatch || null,
    };
  } catch { return { pass: true }; }
}

async function _compilerRunTTS(text, voice) {
  const clean = text
    .replace(/\[VISUAL:[^\]]*\]/gi, '').replace(/\[MUSIC:[^\]]*\]/gi, '')
    .replace(/\[[^\]]{0,80}\]/g, '').replace(/\n{2,}/g, ' ... ')
    .replace(/—/g, ', ').replace(/\s{2,}/g, ' ').trim();

  const sentences = clean.match(/[^.!?]+[.!?]+["']?\s*/g) || [clean];
  const chunks = []; let cur = '', wc = 0;
  for (const s of sentences) {
    const w = s.trim().split(/\s+/).length;
    if (wc + w > 600 && cur) { chunks.push(cur.trim()); cur = s; wc = w; }
    else { cur += s; wc += w; }
  }
  if (cur.trim()) chunks.push(cur.trim());

  const allPcm = []; let sampleRate = 24000;
  for (let i = 0; i < chunks.length; i++) {
    _cstepSet('tts', 'running', `Part ${i + 1} of ${chunks.length}…`);
    const r = await geminiTTS({ text: chunks[i], voice });
    if (r.error) return { error: r.error };
    sampleRate = parseInt(r.mimeType?.match(/rate=(\d+)/)?.[1] || '24000');
    for (const b64 of r.audioParts) allPcm.push(base64ToBytes(b64));
  }
  const totalLen = allPcm.reduce((s, a) => s + a.length, 0);
  const pcmBytes = new Uint8Array(totalLen);
  let off = 0; for (const a of allPcm) { pcmBytes.set(a, off); off += a.length; }
  const wavBytes = pcmToWav(pcmBytes, sampleRate, 1, 16);
  return { blob: new Blob([wavBytes], { type: 'audio/wav' }) };
}

function _compilerBuildFileList(segments) {
  return segments.map(s => {
    const ext  = s.videoData ? 'mp4' : 'png';
    const name = `scene_${String(s.id).padStart(2,'0')}_${s.duration}s.${ext}`;
    return `file '${name}'\nduration ${s.duration}`;
  }).join('\n');
}

function _compilerBuildFFmpegCmd(voice, segments) {
  if (!segments || !segments.some(s => s.videoData)) {
    // All stills — simple concat
    return `ffmpeg -f concat -safe 0 -i filelist.txt -i narration-${voice.toLowerCase()}.wav -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest output.mp4`;
  }
  // Mixed video clips + still images
  const inputs = segments.map(s => {
    const ext  = s.videoData ? 'mp4' : 'png';
    const name = `scene_${String(s.id).padStart(2,'0')}_${s.duration}s.${ext}`;
    return s.videoData
      ? `-t ${s.duration} -i ${name}`
      : `-loop 1 -t ${s.duration} -i ${name}`;
  }).join(' ');
  const n = segments.length;
  return `ffmpeg ${inputs} -i narration-${voice.toLowerCase()}.wav -filter_complex "concat=n=${n}:v=1:a=0[v]" -map "[v]" -map ${n}:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest output.mp4`;
}

async function _compilerDownloadZip(segments, videoTitle, ffmpegCmd, filelistTxt, voice) {
  const JSZip = window.JSZip;
  if (!JSZip) {
    return showToast('JSZip unavailable — download files individually using the ⬇ buttons.', 'error');
  }
  const btn = get('compiler-download-btn');
  btn.disabled = true; btn.textContent = '⏳ Building ZIP…';

  const zip = new JSZip();

  for (const seg of segments) {
    if (seg.videoData) {
      const videoBytes = Uint8Array.from(atob(seg.videoData), c => c.charCodeAt(0));
      zip.file(`scene_${String(seg.id).padStart(2,'0')}_${seg.duration}s.mp4`, videoBytes);
    } else if (seg.imageData) {
      zip.file(`scene_${String(seg.id).padStart(2,'0')}_${seg.duration}s.png`, seg.imageData, { base64: true });
    }
  }

  const wavFilename = `narration-${voice.toLowerCase()}.wav`;
  if (_compilerWavBlob) {
    zip.file(wavFilename, await _compilerWavBlob.arrayBuffer());
  }

  let startTime = 0;
  const timeline = {
    title: videoTitle,
    total_duration: `${segments.reduce((s, seg) => s + seg.duration, 0)}s`,
    segments: segments.map(seg => {
      const entry = {
        id: seg.id,
        start: startTime.toFixed(1),
        end: (startTime + seg.duration).toFixed(1),
        file: `scene_${String(seg.id).padStart(2,'0')}_${seg.duration}s.${seg.videoData ? 'mp4' : 'png'}`,
        type: seg.videoData ? 'video' : 'image',
        voiceover: seg.voiceover,
        veo3_motion: seg.veo3Motion || '',
        text_overlay: seg.textOverlay || null,
      };
      startTime += seg.duration;
      return entry;
    }),
  };
  zip.file('timeline.json', JSON.stringify(timeline, null, 2));
  zip.file('filelist.txt', filelistTxt);
  zip.file('ffmpeg_stitch.txt', ffmpegCmd);
  zip.file('style_guide.txt', _compilerStyleGuide);
  const _zipVeo3 = segments.filter(s => s.veo3Motion).map((s, i) => `Veo 3 Prompt ${i + 1}:\n${s.veo3Motion}`).join('\n\n');
  if (_zipVeo3) zip.file('veo3_motion_prompts.txt', _zipVeo3);

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'video-package.zip'; a.click();

  btn.disabled = false; btn.textContent = '⬇ Download Package ZIP';
  showToast('ZIP downloaded!', 'success');
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function show(id) { get(id).style.display = 'block'; }

function setLoading(btn, originalText, loading = true) {
  btn.disabled = loading;
  btn.textContent = loading ? '⏳ Working…' : originalText;
}

function toggleForm(id) {
  const el = get(id);
  const hidden = window.getComputedStyle(el).display === 'none';
  el.style.display = hidden ? 'block' : 'none';
}

function hideForm(id) { get(id).style.display = 'none'; }

function setStatus(id, msg, type) {
  const el = get(id);
  if (!el) return;
  el.innerHTML = `<span class="status-${type}">${msg}</span>`;
  setTimeout(() => { el.innerHTML = ''; }, 4000);
}

function copyText(text) {
  navigator.clipboard.writeText(text.trim()).then(() => showToast('Copied!', 'success'));
}

function showToast(msg, type = 'success') {
  const icon = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' }[type] ?? '✅';
  const t = document.createElement('div');
  t.className = `ccp-toast ccp-toast-${type}`;
  t.textContent = `${icon} ${msg}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
