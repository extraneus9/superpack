// Turns a stored Windows toast XML payload into the few fields the Bloom pill shows.
// Small regex reader on purpose: payloads are flat and we only need texts, the logo image and the launch target.

const ent = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&');

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? ent(m[1]) : null;
}

function decode(buf) {
  if (typeof buf === 'string') return buf;
  const b = Buffer.from(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le', 2);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString('utf8', 3);
  return b.toString('utf8');
}

function parseToast(payload) {
  const xml = decode(payload);
  const toastTag = (xml.match(/<toast\b[^>]*>/i) || [''])[0];
  const binding = (xml.match(/<binding\b[^>]*>([\s\S]*?)<\/binding>/i) || [null, xml])[1];
  const texts = [...binding.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)]
    .filter((m) => !/placement\s*=\s*["']attribution/i.test(m[1]))
    .map((m) => ent(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const images = [...binding.matchAll(/<image\b[^>]*>/gi)].map((m) => ({
    src: attr(m[0], 'src'), placement: attr(m[0], 'placement'), crop: attr(m[0], 'hint-crop'),
  }));
  // legacy ToastImageAndText templates use their single image as the app logo
  const logo = images.find((i) => i.placement === 'appLogoOverride')
    || (/template\s*=\s*["']ToastImageAndText/i.test(xml) ? images.find((i) => !i.placement) : null);
  const header = (xml.match(/<header\b[^>]*>/i) || [''])[0];
  return {
    title: texts[0] || (header ? attr(header, 'title') : '') || '',
    body: texts.slice(1).join(' · '),
    duration: attr(toastTag, 'duration'), // "long" = Windows keeps it ~25 s
    scenario: attr(toastTag, 'scenario'), // reminder / alarm / incomingCall stay until dismissed
    launch: attr(toastTag, 'launch'),
    activationType: attr(toastTag, 'activationType'),
    logo: logo ? logo.src : null,
    logoRound: !!(logo && logo.crop === 'circle'),
  };
}

module.exports = { parseToast };
