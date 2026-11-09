// Turkish → English translation for the panel (POST /admin/api/translate, signed-in only).
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

const TRANSLATE_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/mistralai/mistral-small-3.1-24b-instruct'];
const TRANSLATE_PROMPT = `You translate the website of Federal Gold, a jeweller in Istanbul's Grand Bazaar, from Turkish to English.
Write short, natural, elegant British English, the way a fine jewellery shop writes; not word for word.
Jewellery words: bilezik = bracelet, kelepçe = cuff bracelet, burma = twisted bracelet, hasır = woven, gurmet = curb chain,
kolye = necklace, gerdanlık = statement necklace, zincir = chain, yüzük = ring, tektaş = solitaire, alyans = wedding band,
küpe = earring, halka = hoop, sallantı = drop, taşlı = with stones, set = set, tuğralı = tughra, külçe = bar, sikke = coin,
çeyrek altın = quarter gold coin, yarım altın = half gold coin, tam altın = full gold coin, gram altın = gram gold,
ayar = karat, milyem = fineness, işçilik = craftsmanship, kuyumculuk = jewellery, mağaza = store, şube = branch.
Places: Kapalıçarşı = Grand Bazaar, İstanbul = Istanbul. Other names (Şemdinli, Van, Hakkari, Fatih, Muhafazacılar, Cumhuriyet)
stay as they are. In addresses: Sk./Sokak = St., Cd./Caddesi = St., İş Merkezi = Business Centre, Kat = Floor, No = No.
Days: Pzt = Mon, Cmt = Sat, Pazar = Sunday; "Pazar kapalı" = "Closed Sunday".
Keep exactly as they are: "Federal Gold", phone numbers, prices, times, numbers, symbols such as · | → and emoji, and any
{placeholder} in curly braces (they are filled in later, so the sentence must still read well around them).
Keep the capitalisation style: ALL CAPS stays ALL CAPS, Title Case product names stay Title Case.
Examples from this site:
"Kapalıçarşı’da mağaza" → "Store in the Grand Bazaar"; "Gelin, görün, deneyin" → "Come, see, try on";
"Mağazamızdan seçmeler" → "Selected pieces from our store"; "Sigortalı gönderim" → "Insured delivery";
"Hemen ara" → "Call now"; "Yol tarifi al" → "Get directions"; "Bilgi al" → "Enquire";
"Merhaba, {name}{details} hakkında bilgi almak istiyorum." → "Hello, I'd like some information about {name}{details}.";
"Tuğralı Kelepçe Bilezik" → "Tughra Cuff Bracelet".
Input is a JSON object; reply with ONLY a JSON object with the same keys and the English texts as values.`;

export async function translateTexts(request, env) {
  if (!env.AI) return Response.json({ error: 'AI kullanılamıyor' }, { status: 503, headers: securityHeaders });
  let body;
  try { body = await request.json(); } catch { return new Response('Bad request', { status: 400, headers: securityHeaders }); }
  const texts = body && body.texts && typeof body.texts === 'object' ? body.texts : null;
  const keys = texts ? Object.keys(texts) : [];
  if (!keys.length || keys.length > 80 || keys.some((k) => !/^\w{1,40}$/.test(k) || typeof texts[k] !== 'string' || texts[k].length > 2000)) {
    return new Response('Bad texts', { status: 400, headers: securityHeaders });
  }
  const braces = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  const out = {};
  let todo = keys.filter((k) => texts[k].trim());
  let lastErr = '';
  for (const model of [...TRANSLATE_MODELS, ...TRANSLATE_MODELS]) {
    if (!todo.length) break;
    try {
      const input = Object.fromEntries(todo.map((k) => [k, texts[k]]));
      const res = await env.AI.run(model, { max_tokens: 4000, temperature: 0.2, messages: [
        { role: 'system', content: TRANSLATE_PROMPT }, { role: 'user', content: JSON.stringify(input) }] });
      let r = res && (res.response ?? (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ?? res.result ?? res);
      if (typeof r !== 'object') { const m = String(r || '').match(/\{[\s\S]*\}/); r = m ? JSON.parse(m[0]) : null; }
      if (!r || typeof r !== 'object') { lastErr = 'unparsed'; continue; }
      for (const k of todo) {
        const v = typeof r[k] === 'string' ? r[k].replace(/[<>]/g, '').trim() : '';
        // keep only answers that look like a translation of this text (placeholders intact, sane length)
        if (v && braces(v) === braces(texts[k]) && v.length <= texts[k].length * 3 + 20) out[k] = v;
      }
      todo = todo.filter((k) => !(k in out));
    } catch (e) { lastErr = String(e && e.message || e).slice(0, 300); }
  }
  return Response.json({ translations: out, missing: todo, detail: todo.length ? lastErr : undefined }, { headers: securityHeaders });
}

