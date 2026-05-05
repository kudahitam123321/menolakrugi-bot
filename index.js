import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits } from 'discord.js';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Config
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GUILD_ID = '1056938665688969318';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://menolakrugi.netlify.app/discord-callback';

// Role IDs
const ROLES = {
  'SMC Trial': '1497821830231097374',
  'SMC Silver': '1374598659118858320',
  'SMC Bronze': '1374599154164174848',
  'SMC Gold Mentorship': '1374564507858501762',
  'SMC Platinum 1 on 1': '1374599652321525921',
  'Basic': '1390888552367132673',
  'Advanced': '1390888679123189760',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Discord Bot Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
});

client.login(BOT_TOKEN);

// Helper: format nickname Discord
function formatNickname(namaLengkap) {
  const kata = namaLengkap.trim().split(/\s+/);
  const muhamadVariants = ['muhammad', 'muhamad', 'mohammad', 'mohamad', 'muhammah'];
  let namaPanggil = kata[0];
  if (muhamadVariants.includes(kata[0].toLowerCase()) && kata.length > 1) {
    namaPanggil = kata[1];
  }
  // Capitalize huruf pertama
  namaPanggil = namaPanggil.charAt(0).toUpperCase() + namaPanggil.slice(1).toLowerCase();
  return `[✅] ${namaPanggil}_ᴾᵀᴹᴿ`;
}

// Helper: set nickname member di Discord
async function setMemberNickname(discordUserId, namaLengkap) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId);
    const nickname = formatNickname(namaLengkap);
    await member.setNickname(nickname);
    console.log(`Nickname set: ${nickname}`);
    return { success: true, nickname };
  } catch (err) {
    console.error('Error set nickname:', err.message);
    return { success: false, error: err.message };
  }
}

// Helper: set roles untuk member
async function setMemberRoles(discordUserId, tier, isAdvance) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId);

    // Kumpulkan role yang harus diberikan
    const rolesToAdd = [];

    // Role tier
    if (ROLES[tier]) rolesToAdd.push(ROLES[tier]);

    // Role Basic selalu diberikan
    rolesToAdd.push(ROLES['Basic']);

    // Role Advanced hanya kalau sudah approved
    if (isAdvance) rolesToAdd.push(ROLES['Advanced']);

    // Hapus role tier & level lama dulu
    const tierRoleIds = Object.values(ROLES);
    const currentRoles = member.roles.cache
      .filter(r => tierRoleIds.includes(r.id))
      .map(r => r.id);

    if (currentRoles.length > 0) {
      await member.roles.remove(currentRoles);
    }

    // Kasih role baru
    await member.roles.add(rolesToAdd);

    return { success: true };
  } catch (err) {
    console.error('Error set roles:', err.message);
    return { success: false, error: err.message };
  }
}

// Endpoint: OAuth2 callback - terima code dari Discord
app.get('/discord/callback', async (req, res) => {
  const { code, member_id } = req.query;

  if (!code || !member_id) {
    return res.status(400).json({ error: 'Missing code or member_id' });
  }

  try {
    // Tukar code dengan access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).json({ error: 'Invalid code' });
    }

    // Ambil info user Discord
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();

    // Cek member di database
    const { data: member, error: memberError } = await supabase
      .from('members')
      .select('*')
      .eq('id', member_id)
      .single();

    if (memberError || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Join server dulu (kalau belum)
    await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordUser.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: tokenData.access_token }),
    });

    // Simpan Discord ID ke database
    await supabase.from('members').update({
      discord_id: discordUser.id,
      discord_username: discordUser.username,
    }).eq('id', member_id);

    // Set roles
    const result = await setMemberRoles(discordUser.id, member.tier, member.is_advance);

    // Auto set nickname
    await setMemberNickname(discordUser.id, member.nama);

    if (result.success) {
      res.json({ success: true, discord_username: discordUser.username, tier: member.tier });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Sync role (kalau member naik advance)
app.post('/discord/sync', async (req, res) => {
  const { member_id } = req.body;
  const { data: member } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!member || !member.discord_id) return res.status(404).json({ error: 'Member not found or Discord not connected' });
  const result = await setMemberRoles(member.discord_id, member.tier, member.is_advance);
  // Sync nickname juga
  await setMemberNickname(member.discord_id, member.nama);
  res.json(result);
});

// Endpoint: Set nickname manual
app.post('/discord/nickname', async (req, res) => {
  const { member_id } = req.body;
  const { data: member } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!member || !member.discord_id) return res.status(404).json({ error: 'Member tidak ditemukan atau Discord belum terhubung' });
  const result = await setMemberNickname(member.discord_id, member.nama);
  res.json(result);
});

// Endpoint: Kirim pengumuman ke channel Discord
app.post('/discord/announce', async (req, res) => {
  const { channel_id, message } = req.body;
  if (!channel_id || !message) {
    return res.status(400).json({ error: 'channel_id dan message wajib diisi' });
  }
  try {
    const channel = await client.channels.fetch(channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel tidak ditemukan' });
    await channel.send(message);
    res.json({ success: true });
  } catch (err) {
    console.error('Announce error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'MenolakRugi Bot is running!' }));

// ─── Session Scheduler ───────────────────────────────────────────────
const SESSION_CHANNEL = '1390897671874674728';

const SESSION_MESSAGES = {
  // Format: 'HH:MM' dalam WITA (UTC+8)
  '07:00': {
    msg: `🌸 **SESSION TOKYO DIBUKA**\n\nSesi Asia resmi dimulai! Likuiditas mulai meningkat.\n\n📊 Pair yang aktif: **USD/JPY, EUR/JPY, GBP/JPY**\n\n> Perhatikan level-level penting dari sesi sebelumnya. Setup IDM dan OB sering terbentuk di sini! 🎯`,
  },
  '16:00': {
    msg: `🌸 **SESSION TOKYO DITUTUP**\n\nSesi Tokyo telah berakhir. Bersiap menyambut sesi London!\n\n> Evaluasi setup yang sudah terbentuk dan tunggu konfirmasi dari London. 📈`,
  },
  '15:00': {
    msg: `🇬🇧 **SESSION LONDON DIBUKA** — ⚡ OVERLAP TOKYO + LONDON!\n\nINI WAKTU EMAS! Dua sesi besar bertemu — volatilitas dan likuiditas sedang tinggi-tingginya.\n\n📊 Pair paling aktif: **GBP/USD, EUR/USD, GBP/JPY, EUR/JPY**\n\n> Sesi overlap = banyak likuiditas yang disapu. IDM, BOS, dan OB sering terjadi di sini. Siapkan setup terbaikmu! 🔥`,
  },
  '00:00': {
    msg: `🇬🇧 **SESSION LONDON DITUTUP**\n\nSesi London telah berakhir. New York masih berjalan hingga pukul 05:00 WITA.\n\n> Jika belum ada setup valid, lebih baik istirahat. Jangan trading karena bosan! 😴`,
  },
  '20:00': {
    msg: `🗽 **SESSION NEW YORK DIBUKA** — ⚡ OVERLAP LONDON + NEW YORK!\n\nOVERLAP TERBESAR DAN TERPENTING HARI INI! Ini adalah sesi dengan volume trading tertinggi.\n\n📊 Pair paling aktif: **EUR/USD, GBP/USD, USD/JPY, XAU/USD**\n\n> Mayoritas pergerakan besar terjadi di sini. Setup yang sudah terbentuk sejak London sering ter-trigger sekarang. FOKUS dan DISIPLIN! 🚀🔥`,
  },
  '05:01': {
    msg: `🔴 **SESSION NEW YORK DITUTUP — MARKET SELESAI HARI INI**\n\nSemua sesi utama telah berakhir. Waktunya evaluasi dan istirahat.\n\n📝 Jangan lupa isi jurnal trading hari ini!\n\n> Konsistensi journaling = kunci berkembang lebih cepat. Sampai besok, Sobat Trader! 💪`,
  },
};

function getWITATime() {
  const now = new Date();
  // UTC+8
  const wita = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const hh = String(wita.getUTCHours()).padStart(2, '0');
  const mm = String(wita.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function sendSessionMessage(msg) {
  try {
    const channel = await client.channels.fetch(SESSION_CHANNEL);
    if (channel) await channel.send(msg);
  } catch (err) {
    console.error('Session msg error:', err.message);
  }
}

// Cek setiap menit
let lastSent = '';
setInterval(async () => {
  const time = getWITATime();
  if (SESSION_MESSAGES[time] && lastSent !== time) {
    lastSent = time;
    await sendSessionMessage(SESSION_MESSAGES[time].msg);
    console.log(`Session message sent: ${time}`);
  }
}, 60 * 1000);

console.log('Session scheduler aktif (WITA/UTC+8)');
// ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
