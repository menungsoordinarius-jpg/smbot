// commands/tools/figlet.js
// Pemakaian: .figlet scale "3" word "kata" <halo>
// Opsi boleh dikosongkan, yang wajib hanya <teks>.

// ===== PENGATURAN =====
// same = pakai huruf yang diketik pengguna (besar/kecil tetap)
// add  = semua titik diisi huruf/simbol yang ditetapkan
// word = titik diisi kata yang ditetapkan, berulang
const SETTING_default = 'same';
const DEFAULT_ISI = { add: '#', word: 'SMBOT' }; // dipakai kalau mode add/word tanpa nilai
const DEFAULT_SCALE = 1;
const MAX_SCALE = 6;
const MAX_CHARS = 30;
const MAX_WIDTH = 34; // lebar kolom per baris sebelum pindah baris

// ===== FONT 5 baris, '#' = isi, '/' = pemisah baris =====
const F = {
  A: '.###./#...#/#####/#...#/#...#',
  B: '####./#...#/####./#...#/####.',
  C: '.####/#..../#..../#..../.####',
  D: '####./#...#/#...#/#...#/####.',
  E: '#####/#..../####./#..../#####',
  F: '#####/#..../####./#..../#....',
  G: '.####/#..../#.###/#...#/.###.',
  H: '#...#/#...#/#####/#...#/#...#',
  I: '#####/..#../..#../..#../#####',
  J: '..###/...#./...#./#..#./.##..',
  K: '#...#/#..#./###../#..#./#...#',
  L: '#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#..##/#...#',
  O: '.###./#...#/#...#/#...#/.###.',
  P: '####./#...#/####./#..../#....',
  Q: '.###./#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/####./#..#./#...#',
  S: '.####/#..../.###./....#/####.',
  T: '#####/..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#.#.#/##.##/#...#',
  X: '#...#/.#.#./..#../.#.#./#...#',
  Y: '#...#/.#.#./..#../..#../..#..',
  Z: '#####/...#./..#../.#.../#####',
  0: '.###./#..##/#.#.#/##..#/.###.',
  1: '..#../.##../..#../..#../.###.',
  2: '.###./#...#/..##./.#.../#####',
  3: '####./....#/.###./....#/####.',
  4: '#..#./#..#./#####/...#./...#.',
  5: '#####/#..../####./....#/####.',
  6: '.###./#..../####./#...#/.###.',
  7: '#####/....#/...#./..#../..#..',
  8: '.###./#...#/.###./#...#/.###.',
  9: '.###./#...#/.####/....#/.###.',
  '!': '#/#/#/./#',
  '?': '.###./#...#/..##./...../..#..',
  '.': '././././#',
  '-': '...../...../#####/...../.....',
  ':': '.../.#./.../.#./...',
  ' ': '.../.../.../.../...',
};
const FONT = {};
for (const [k, v] of Object.entries(F)) FONT[k] = v.split('/');

// ===== PARSER =====
function parse(raw) {
  const t = raw.replace(/[“”]/g, '"');
  const m = t.match(/<([\s\S]*)>/);
  if (!m) return null;
  const opts = t.slice(0, m.index);
  const scale = opts.match(/\bscale\s+"?(\d+)"?/i);
  const word = opts.match(/\bword(?:\s+"([^"]*)")?/i);
  const add = opts.match(/\badd(?:\s+"([^"]*)")?/i);

  let mode = SETTING_default;
  let isi = DEFAULT_ISI[mode] || '';
  if (word) { mode = 'word'; isi = word[1] || DEFAULT_ISI.word; }
  else if (add) { mode = 'add'; isi = add[1] || DEFAULT_ISI.add; }
  else if (/\bsame\b/i.test(opts)) mode = 'same';
  else if (mode !== 'same') isi = DEFAULT_ISI[mode];

  let sc = scale ? parseInt(scale[1], 10) : DEFAULT_SCALE;
  sc = Math.min(Math.max(sc, 1), MAX_SCALE);
  if (mode === 'add') isi = Array.from(isi)[0] || '#';
  return { text: m[1], scale: sc, mode, isi: Array.from(isi) };
}

// ===== RENDER =====
function renderChunk(items, scale, mode, isi) {
  const rows = [];
  let base = 0;
  const pick = (x, ch) =>
    mode === 'same' ? ch : mode === 'add' ? isi[0] : isi[x % isi.length];

  const lines = Array.from({ length: 5 }, () => '');
  for (const { ch, g } of items) {
    const w = g[0].length;
    for (let r = 0; r < 5; r++) {
      let line = '';
      for (let c = 0; c < w; c++) {
        for (let s = 0; s < scale; s++) {
          const x = base + c * scale + s;
          line += g[r][c] === '#' ? pick(x, ch) : ' ';
        }
      }
      lines[r] += line + ' '.repeat(scale);
    }
    base += (w + 1) * scale;
  }
  for (const l of lines) for (let s = 0; s < scale; s++) rows.push(l.trimEnd());
  return rows.join('\n');
}

function render({ text, scale, mode, isi }) {
  const items = [];
  for (const ch of Array.from(text).slice(0, MAX_CHARS)) {
    const g = FONT[ch.toUpperCase()];
    if (g) items.push({ ch, g });
  }
  if (!items.length) return '';

  const chunks = [];
  let cur = [];
  let width = 0;
  for (const it of items) {
    const w = (it.g[0].length + 1) * scale;
    if (cur.length && width + w > MAX_WIDTH) {
      chunks.push(cur);
      cur = [];
      width = 0;
    }
    cur.push(it);
    width += w;
  }
  if (cur.length) chunks.push(cur);

  return chunks.map((c) => renderChunk(c, scale, mode, isi)).join('\n\n');
}

// ===== COMMAND =====
module.exports = async function figlet(sock, m, text) {
  const from = m.key.remoteJid;
  const reply = (t) => sock.sendMessage(from, { text: t }, { quoted: m });

  try {
    const p = parse(text);
    if (!p) {
      await reply(
        '❌ Tulis teksnya di dalam <>.\n\n' +
        'Contoh:\n.figlet <halo>\n.figlet scale "3" <halo>\n' +
        '.figlet add "#" <halo>\n.figlet scale "2" word "kata" <halo>'
      );
      return false;
    }
    const out = render(p);
    if (!out) {
      await reply('❌ Tidak ada huruf yang bisa dibuat. Pakai A-Z, 0-9, ! ? . - :');
      return false;
    }
    await reply('```\n' + out + '\n```');
    return true;
  } catch (e) {
    await reply('❌ Gagal: ' + e.message);
    return false;
  }
};
