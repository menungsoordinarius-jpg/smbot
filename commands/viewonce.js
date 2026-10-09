const { downloadMediaMessage} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const os = require('os');    
const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function ffmpegConvert(buffer, inExt, outExt, args) {
    const id = uid();
    const tmpIn = path.join(__dirname, `tmp_${id}.${inExt}`);
    const tmpOut = path.join(__dirname, `tmp_${id}.${outExt}`);
    await fs.promises.writeFile(tmpIn, buffer);
    try {
        await execPromise(`ffmpeg -y ${args.pre || ''} -i "${tmpIn}" ${args.post || ''} "${tmpOut}"`);
        return await fs.promises.readFile(tmpOut);
    } finally {
        await fs.promises.unlink(tmpIn).catch(() => {});
        await fs.promises.unlink(tmpOut).catch(() => {});
    }
}

const run = (cmd) => execPromise(cmd, { maxBuffer: 1024 * 1024 * 50 });

const isAnimatedWebp = (buf) => buf.subarray(0, 256).includes('ANIM');

async function extractWebpFrames(buffer) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webp_'));
    const input = path.join(dir, 'in.webp');
    await fs.promises.writeFile(input, buffer);

    // Bongkar semua frame (sudah dikomposit penuh)
    await run(`magick "${input}" -coalesce "${dir}/f_%04d.png"`);

    // Hitung fps dari delay tiap frame (satuan 1/100 detik)
    let fps = 10;
    try {
        const { stdout } = await run(`identify -format "%T\\n" "${input}"`);
        const delays = stdout.split('\n').map(Number).filter(d => d > 0);
        if (delays.length) {
            const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
            fps = Math.min(30, Math.max(1, Math.round(100 / avg)));
        }
    } catch {}
    return { dir, fps };
}

async function webpToMp4(buffer) {
    // Stiker statis: ffmpeg cukup
    if (!isAnimatedWebp(buffer)) {
        return await ffmpegConvert(buffer, 'webp', 'mp4', {
            pre: '-loop 1',
            post: '-t 3 -c:v libx264 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -movflags +faststart'
        });
    }
    const { dir, fps } = await extractWebpFrames(buffer);
    const out = path.join(dir, 'out.mp4');
    try {
        await run(`ffmpeg -y -loglevel error -framerate ${fps} -i "${dir}/f_%04d.png" -c:v libx264 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -movflags +faststart "${out}"`);
        return await fs.promises.readFile(out);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

async function webpToImage(buffer) {
    if (!isAnimatedWebp(buffer)) return await ffmpegConvert(buffer, 'webp', 'jpg', {});
    const { dir } = await extractWebpFrames(buffer);
    try {
        const first = path.join(dir, 'f_0000.png');
        const out = path.join(dir, 'out.jpg');
        await run(`ffmpeg -y -loglevel error -i "${first}" "${out}"`);
        return await fs.promises.readFile(out);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// MP4 -> file GIF asli (palet warna dioptimalkan)
const mp4ToGif = (buf) => ffmpegConvert(buf, 'mp4', 'gif', {
    post: '-vf "fps=12,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0'
});
const videoToImage = (buf) => ffmpegConvert(buf, 'mp4', 'jpg', { post: '-frames:v 1' })
const react = (sock, from, m, emoji) =>
    sock.sendMessage(from, { react: { text: emoji, key: m.key } }).catch(() => {});

module.exports = async (sock, from, m, text) => {
    const [cmd, ...args] = text.trim().split(/\s+/);
    const c = cmd.toLowerCase();
    const isToImg = c === '.toimg';
    const isToMp4 = c === '.tomp4' || c === '.tvideo';
    const isToGif = c === '.gif' || c === '.togif';
    if (!isToImg && !isToMp4 && !isToGif) return;

    const isDocument = args.some(a => ['dcm', 'doc'].includes(a.toLowerCase()));

    const msg = m.message || {};
    const contextInfo =
        msg.extendedTextMessage?.contextInfo ||
        msg.imageMessage?.contextInfo ||
        msg.videoMessage?.contextInfo;
    let targetMsg = contextInfo?.quotedMessage;

    if (!targetMsg) {
        await sock.sendMessage(from, {
            text: 'Balas/reply pesan foto, video, atau stiker dengan perintah *.toimg*, *.tomp4*, atau *.gif*!'
        }, { quoted: m });
        return;
    }

    if (targetMsg.viewOnceMessage) targetMsg = targetMsg.viewOnceMessage.message;
    if (targetMsg.viewOnceMessageV2) targetMsg = targetMsg.viewOnceMessageV2.message;
    if (targetMsg.viewOnceMessageV2Extension) targetMsg = targetMsg.viewOnceMessageV2Extension.message;

    const hasImage = targetMsg.imageMessage;
    const hasVideo = targetMsg.videoMessage;
    const hasSticker = targetMsg.stickerMessage;

    if (!hasImage && !hasVideo && !hasSticker) {
        await sock.sendMessage(from, { text: 'Tidak ditemukan media foto, video, atau stiker pada pesan yang dibalas.' }, { quoted: m });
        return;
    }

    try {
        await react(sock, from, m, '⏳');
        const msgToDownload = {
            key: {
                remoteJid: from,
                id: contextInfo.stanzaId,
                participant: contextInfo.participant
            },
            message: targetMsg
        };

        let buffer = await downloadMediaMessage(
            msgToDownload, 'buffer', {},
            { logger: console, reuploadRequest: sock.updateMediaMessage }
        );

        if (!buffer || buffer.length === 0) {
            await sock.sendMessage(from, { text: 'Gagal mengunduh file media.' }, { quoted: m });
            return;
        }

        // Konversi sesuai sumber & tujuan
        if (isToImg) {
            if (hasSticker) buffer = await webpToImage(buffer);
            else if (hasVideo) buffer = await videoToImage(buffer);
        } else {
            if (hasSticker) buffer = await webpToMp4(buffer);
            else if (hasImage) {
                await sock.sendMessage(from, { text: 'Untuk foto, gunakan *.toimg* saja.' }, { quoted: m });
                return;
            }
        }

        if (isToImg) {
            if (isDocument) {
                await sock.sendMessage(from, {
                    document: buffer, mimetype: 'image/jpeg',
                    fileName: `✦ image ${Date.now()}.jpg`,
                    caption: 'Ini file dokumen gambarnya!'
                }, { quoted: m });
            } else {
                await sock.sendMessage(from, { image: buffer, caption: 'Berhasil mengambil/mengubah foto!' }, { quoted: m });
            }
        } else if (isToMp4) {
            if (isDocument) {
                await sock.sendMessage(from, {
                    document: buffer, mimetype: 'video/mp4',
                    fileName: `✦ Video ${Date.now()}.mp4`,
                    caption: 'Ini file dokumen videonya!'
                }, { quoted: m });
            } else {
                await sock.sendMessage(from, { video: buffer, caption: 'Berhasil mengambil/mengubah video!' }, { quoted: m });
            } 
        } else if (isToGif) {
           if (isDocument) {
             const gifBuf = await mp4ToGif(buffer);
                 await sock.sendMessage(from, {
                 document: gifBuf, mimetype: 'image/gif',
                 fileName: `✦ gif ${Date.now()}.gif`,
                 caption: 'Ini file dokumen GIF!'
           }, { quoted: m });
            } else {
                await sock.sendMessage(from, {
                  video: buffer, gifPlayback: true,
                  caption: 'Berhasil mengubah ke GIF!'
            }, { quoted: m });
          }
         }
        await react(sock, from, m, '✅');
} catch (err) {
        console.error(err);
        await react(sock, from, m, '❌');
        await sock.sendMessage(from, { text: 'Gagal mengambil atau mengonversi media dari pesan tersebut.' }, { quoted: m });
    }
};
