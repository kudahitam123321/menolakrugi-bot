import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { createClient } from '@supabase/supabase-js';

// DIAGNOSTIK SEMENTARA — cek nama env var port yang di-inject Wispbyte
// (aman: cuma nama variabel + nilai yang mengandung kata "port", bukan rahasia)
console.log('=== ENV VARS mengandung "port" ===');
Object.keys(process.env).filter(k => /port/i.test(k)).forEach(k => console.log(`${k} = ${process.env[k]}`));
console.log('=== SEMUA NAMA ENV VAR (nilai disembunyikan) ===');
console.log(Object.keys(process.env).join(', '));
console.log('=== END DIAGNOSTIK ===');

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

// Funded Role IDs
const FUNDED_ROLES = {
  'P1':    '1450143559704510534',
  'P2':    '1450143702193405952',
  'Master':'1450143778407977144',
  'MPAID': '1432673955596210206',
  'Ap':    '1295584121778868314',
  'DA':    '',  // Demo Account — isi role ID jika ada, kosong = tidak set role
};

// Tier emoji prefix
const TIER_EMOJI = {
  'SMC Platinum 1 on 1': '💎',
  'SMC Gold Mentorship':  '🥇',
  'SMC Silver':           '🥈',
  'SMC Bronze':           '🥉',
  'SMC Trial':            '🕒',
};

// Funded suffix
const FUNDED_SUFFIX = {
  'P1':    '·P1',
  'P2':    '·P2',
  'Master':'·MST',
  'MPAID': '·MPAID',
  'Ap':    '·Ap',
  'DA':    '·DA',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Discord Bot Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', async () => {
  console.log(`Bot ready: ${client.user.tag}`);

  // Register slash command /sync-nickname
  const commands = [
    new SlashCommandBuilder()
      .setName('sync-nickname')
      .setDescription('Update semua nickname member berdasarkan role Discord mereka')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash command /sync-nickname registered');
  } catch (err) {
    console.error('Gagal register slash command:', err.message);
  }
});

// Handler slash command /sync-nickname
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'sync-nickname') return;

  // Hanya owner server atau admin yang bisa jalankan
  const member = interaction.member;
  const isAdmin = member.permissions.has('Administrator');
  const isOwner = interaction.guild.ownerId === interaction.user.id;

  if (!isAdmin && !isOwner) {
    return interaction.reply({ content: '❌ Kamu tidak punya izin menjalankan perintah ini.', ephemeral: true });
  }

  await interaction.reply({ content: '⏳ Memperbarui nickname semua member... Harap tunggu.', ephemeral: true });

  try {
    const guild = interaction.guild;
    const allMembers = await guild.members.fetch();

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const [, guildMember] of allMembers) {
      if (guildMember.user.bot) continue;

      const memberRoleIds = guildMember.roles.cache.map(r => r.id);

      // Cek punya tier role
      const tierEntry = Object.entries(ROLES).find(([key, roleId]) =>
        !['Basic', 'Advanced'].includes(key) && memberRoleIds.includes(roleId)
      );
      if (!tierEntry) { skipped++; continue; }

      const detectedTier = tierEntry[0];
      const fundedEntry = Object.entries(FUNDED_ROLES).find(([, roleId]) =>
        memberRoleIds.includes(roleId)
      );
      const detectedFunded = fundedEntry ? fundedEntry[0] : null;

      // Coba cari nama di database
      const { data: dbMember } = await supabase
        .from('members')
        .select('nama')
        .eq('discord_id', guildMember.id)
        .single();

      const nama = dbMember?.nama
        || extractNameFromNickname(guildMember.nickname)
        || guildMember.user.displayName
        || guildMember.user.username;

      const nickname = formatNickname(nama, detectedTier, detectedFunded);

      try {
        await guildMember.setNickname(nickname);
        updated++;
        await new Promise(r => setTimeout(r, 500)); // delay biar tidak kena rate limit
      } catch {
        errors++;
      }
    }

    await interaction.editReply(
      `✅ **Sync selesai!**\n` +
      `📝 Diupdate: **${updated}** member\n` +
      `⏭️ Dilewati (tanpa role): **${skipped}** member\n` +
      `❌ Gagal: **${errors}** member`
    );
  } catch (err) {
    console.error('sync-nickname command error:', err.message);
    await interaction.editReply('❌ Terjadi error saat sync. Cek log bot.');
  }
});

// Helper: ekstrak nama dari nickname Discord yang sudah ada
// Contoh: "[✅] Erckxml_ᴾᵀᴹᴿ" → "Erckxml"
// Contoh: "[🥇]Ahmad_ᴾᵀᴹᴿ·P1" → "Ahmad"
function extractNameFromNickname(nickname) {
  if (!nickname) return null;
  // Hapus prefix [emoji] atau [✅] dll
  let name = nickname.replace(/^\[.*?\]\s*/, '');
  // Hapus suffix _ᴾᵀᴹᴿ dan apapun setelahnya
  name = name.split('_ᴾᵀᴹᴿ')[0];
  return name.trim() || null;
}

// Event: otomatis update nickname ketika role member berubah manual di Discord
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    // Cek apakah ada perubahan role yang relevan
    const oldRoleIds = oldMember.roles.cache.map(r => r.id);
    const newRoleIds = newMember.roles.cache.map(r => r.id);

    const allManagedIds = [
      ...Object.values(ROLES),
      ...Object.values(FUNDED_ROLES),
    ];

    const roleChanged =
      allManagedIds.some(id => oldRoleIds.includes(id) !== newRoleIds.includes(id));

    if (!roleChanged) return;

    // Deteksi tier dari role aktif
    const tierEntry = Object.entries(ROLES).find(([key, roleId]) =>
      !['Basic', 'Advanced'].includes(key) && newRoleIds.includes(roleId)
    );
    if (!tierEntry) return; // Tidak punya tier role — skip

    const detectedTier = tierEntry[0];

    // Deteksi funded status dari role aktif
    const fundedEntry = Object.entries(FUNDED_ROLES).find(([, roleId]) =>
      newRoleIds.includes(roleId)
    );
    const detectedFunded = fundedEntry ? fundedEntry[0] : null;

    // Cari member di database berdasarkan discord_id
    const { data: dbMember } = await supabase
      .from('members')
      .select('id, nama, tier, funded_status')
      .eq('discord_id', newMember.id)
      .single();

    let namaForNickname;

    if (dbMember) {
      // Member ditemukan di DB — update data jika ada perubahan
      const updates = {};
      if (detectedTier !== dbMember.tier) updates.tier = detectedTier;
      if (detectedFunded !== dbMember.funded_status) updates.funded_status = detectedFunded;
      if (Object.keys(updates).length > 0) {
        await supabase.from('members').update(updates).eq('id', dbMember.id);
      }
      namaForNickname = dbMember.nama;
    } else {
      // Member belum ada di DB / belum hubungkan Discord
      // Coba ambil nama dari nickname Discord yang ada
      const existingNick = newMember.nickname || newMember.user.displayName || newMember.user.username;
      namaForNickname = extractNameFromNickname(newMember.nickname) || newMember.user.displayName || newMember.user.username;
      console.log(`guildMemberUpdate: ${newMember.id} tidak ada di DB, pakai nama dari Discord: ${namaForNickname}`);
    }

    // Format dan set nickname baru
    const nickname = formatNickname(namaForNickname, detectedTier, detectedFunded);
    await newMember.setNickname(nickname);
    console.log(`guildMemberUpdate: ${newMember.id} → ${nickname}`);
  } catch (err) {
    console.error('guildMemberUpdate error:', err.message);
  }
});

// Endpoint: Bulk update nickname semua member di server berdasarkan role Discord mereka
app.post('/discord/sync-all-nicknames', async (req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const allMembers = await guild.members.fetch();

    let updated = 0;
    let skipped = 0;

    for (const [, member] of allMembers) {
      if (member.user.bot) continue;

      const memberRoleIds = member.roles.cache.map(r => r.id);

      // Cek punya tier role
      const tierEntry = Object.entries(ROLES).find(([key, roleId]) =>
        !['Basic', 'Advanced'].includes(key) && memberRoleIds.includes(roleId)
      );
      if (!tierEntry) { skipped++; continue; }

      const detectedTier = tierEntry[0];
      const fundedEntry = Object.entries(FUNDED_ROLES).find(([, roleId]) =>
        memberRoleIds.includes(roleId)
      );
      const detectedFunded = fundedEntry ? fundedEntry[0] : null;

      // Coba cari di database dulu
      const { data: dbMember } = await supabase
        .from('members')
        .select('nama')
        .eq('discord_id', member.id)
        .single();

      const nama = dbMember?.nama
        || extractNameFromNickname(member.nickname)
        || member.user.displayName
        || member.user.username;

      const nickname = formatNickname(nama, detectedTier, detectedFunded);

      try {
        await member.setNickname(nickname);
        updated++;
        // Delay 500ms antar member biar tidak kena rate limit Discord
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`Gagal set nickname ${member.id}:`, e.message);
        skipped++;
      }
    }

    res.json({ success: true, updated, skipped });
  } catch (err) {
    console.error('sync-all-nicknames error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

client.login(BOT_TOKEN);

// Helper: ambil nama panggilan dari nama lengkap
function getNamaPanggil(namaLengkap) {
  const kata = namaLengkap.trim().split(/\s+/);
  const muhamadVariants = ['muhammad', 'muhamad', 'mohammad', 'mohamad', 'muhammah'];
  let namaPanggil = kata[0];
  if (muhamadVariants.includes(kata[0].toLowerCase()) && kata.length > 1) {
    namaPanggil = kata[1];
  }
  return namaPanggil.charAt(0).toUpperCase() + namaPanggil.slice(1).toLowerCase();
}

// Helper: format nickname Discord
// tier: tier kelas member, fundedStatus: null atau key dari FUNDED_SUFFIX
function formatNickname(namaLengkap, tier, fundedStatus = null) {
  const nama = getNamaPanggil(namaLengkap);
  const emoji = TIER_EMOJI[tier] || '🕒';
  const suffix = fundedStatus && FUNDED_SUFFIX[fundedStatus] ? FUNDED_SUFFIX[fundedStatus] : '';
  return `[${emoji}]${nama}_ᴾᵀᴹᴿ${suffix}`;
}

// Helper: set nickname member di Discord
async function setMemberNickname(discordUserId, namaLengkap, tier, fundedStatus = null) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId);
    const nickname = formatNickname(namaLengkap, tier, fundedStatus);
    await member.setNickname(nickname);
    console.log(`Nickname set: ${nickname}`);
    return { success: true, nickname };
  } catch (err) {
    console.error('Error set nickname:', err.message);
    return { success: false, error: err.message };
  }
}

// Helper: set roles untuk member
async function setMemberRoles(discordUserId, tier, isAdvance, fundedStatus = null) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId);

    const rolesToAdd = [];

    // Role tier
    if (ROLES[tier]) rolesToAdd.push(ROLES[tier]);

    // Role Basic selalu diberikan
    rolesToAdd.push(ROLES['Basic']);

    // Role Advanced hanya kalau sudah approved
    if (isAdvance) rolesToAdd.push(ROLES['Advanced']);

    // Role funded (skip jika role ID kosong, misal DA)
    if (fundedStatus && FUNDED_ROLES[fundedStatus] && FUNDED_ROLES[fundedStatus] !== '') {
      rolesToAdd.push(FUNDED_ROLES[fundedStatus]);
    }

    // Hapus semua role tier, level, dan funded lama dulu
    const allManagedRoleIds = [
      ...Object.values(ROLES),
      ...Object.values(FUNDED_ROLES),
    ];
    const currentRoles = member.roles.cache
      .filter(r => allManagedRoleIds.includes(r.id))
      .map(r => r.id);

    if (currentRoles.length > 0) await member.roles.remove(currentRoles);

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
    const result = await setMemberRoles(discordUser.id, member.tier, member.is_advance, member.funded_status);

    // Auto set nickname
    await setMemberNickname(discordUser.id, member.nama, member.tier, member.funded_status);

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

// Endpoint: Sync role (kalau member naik advance atau update funded status)
app.post('/discord/sync', async (req, res) => {
  const { member_id } = req.body;
  const { data: member } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!member || !member.discord_id) return res.status(404).json({ error: 'Member not found or Discord not connected' });
  const result = await setMemberRoles(member.discord_id, member.tier, member.is_advance, member.funded_status);
  await setMemberNickname(member.discord_id, member.nama, member.tier, member.funded_status);
  res.json(result);
});

// Endpoint: Set nickname manual
app.post('/discord/nickname', async (req, res) => {
  const { member_id } = req.body;
  const { data: member } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!member || !member.discord_id) return res.status(404).json({ error: 'Member tidak ditemukan atau Discord belum terhubung' });
  const result = await setMemberNickname(member.discord_id, member.nama, member.tier, member.funded_status);
  res.json(result);
});

// Endpoint: Update funded status member → otomatis update nickname & role Discord
app.post('/discord/funded-status', async (req, res) => {
  const { member_id, funded_status } = req.body;

  // Validasi funded_status
  const validStatus = ['P1', 'P2', 'Master', 'MPAID', 'Ap', 'DA', null];
  if (!validStatus.includes(funded_status)) {
    return res.status(400).json({ error: 'funded_status tidak valid' });
  }

  // Update di database
  const { error: updateError } = await supabase
    .from('members')
    .update({ funded_status })
    .eq('id', member_id);

  if (updateError) return res.status(500).json({ error: updateError.message });

  // Ambil data member terbaru
  const { data: member } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!member || !member.discord_id) return res.json({ success: true, discord_updated: false });

  // Update nickname & role di Discord
  await setMemberRoles(member.discord_id, member.tier, member.is_advance, funded_status);
  const nicknameResult = await setMemberNickname(member.discord_id, member.nama, member.tier, funded_status);

  res.json({ success: true, discord_updated: true, nickname: nicknameResult.nickname });
});

// Endpoint: Member self-report trading status (dari DashboardPage)
app.post('/discord/update-trading-status', async (req, res) => {
  const { member_id, funded_status } = req.body;

  const validStatus = ['P1', 'P2', 'Master', 'MPAID', 'Ap', 'DA', null];
  if (!validStatus.includes(funded_status)) {
    return res.status(400).json({ error: 'Status tidak valid' });
  }

  const { error: updateError } = await supabase
    .from('members')
    .update({ funded_status: funded_status || null })
    .eq('id', member_id);

  if (updateError) return res.status(500).json({ error: updateError.message });

  // Fetch member terbaru
  const { data: member } = await supabase.from('members').select('*').eq('id', member_id).single();
  if (!member) return res.status(404).json({ error: 'Member tidak ditemukan' });

  // Kalau Discord belum terhubung → simpan saja, tidak update nickname
  if (!member.discord_id) {
    return res.json({ success: true, discord_updated: false, message: 'Status disimpan. Hubungkan Discord untuk update nickname.' });
  }

  // Update nickname + role Discord
  await setMemberRoles(member.discord_id, member.tier, member.is_advance, funded_status);
  const nicknameResult = await setMemberNickname(member.discord_id, member.nama, member.tier, funded_status);

  res.json({
    success: true,
    discord_updated: true,
    nickname: nicknameResult.nickname || null,
    message: nicknameResult.success
      ? `Nickname Discord diupdate: ${nicknameResult.nickname}`
      : 'Status disimpan, tapi nickname gagal diupdate (member mungkin tidak ada di server).'
  });
});

// Endpoint: Kirim ucapan selamat naik Advanced (1 member)
app.post('/discord/congrats-advanced', async (req, res) => {
  const { discord_id, discord_username, nama, channel_id } = req.body;
  if (!discord_id || !channel_id) return res.status(400).json({ error: 'discord_id dan channel_id wajib' });
  try {
    const channel = await client.channels.fetch(channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel tidak ditemukan' });
    const msg = `🏆 **SELAMAT <@${discord_id}> — Resmi Naik ke Kelas Advanced!**\n\nKerja keras dan konsistensimu terbayar. Sekarang tantangan sesungguhnya dimulai.\n\nTetap disiplin, tetap berjurnal, dan terus berkembang! 💪\n\n📜 Sertifikat kelulusan kamu sudah tersedia — login ke **menolakrugi.pages.dev** → menu **Sertifikat** → download sekarang!\n\n— Mentor Menolak Rugi 🏆`;
    await channel.send(msg);
    res.json({ success: true });
  } catch (err) {
    console.error('Congrats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Kirim ucapan selamat ke semua member advanced lama (bulk)
app.post('/discord/congrats-all-advanced', async (req, res) => {
  const { channel_id } = req.body;
  if (!channel_id) return res.status(400).json({ error: 'channel_id wajib' });
  try {
    const { data: members } = await supabase
      .from('members')
      .select('nama, discord_id, discord_username')
      .eq('is_advance', true)
      .not('discord_id', 'is', null);
    if (!members || members.length === 0) return res.json({ success: true, sent: 0 });
    const channel = await client.channels.fetch(channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel tidak ditemukan' });
    let sent = 0;
    for (const m of members) {
      try {
        const msg = `🏆 **SELAMAT <@${m.discord_id}> — Resmi Naik ke Kelas Advanced!**\n\nKerja keras dan konsistensimu terbayar. Sekarang tantangan sesungguhnya dimulai.\n\nTetap disiplin, tetap berjurnal, dan terus berkembang! 💪\n\n📜 Sertifikat kelulusan kamu sudah tersedia — login ke **menolakrugi.pages.dev** → menu **Sertifikat** → download sekarang!\n\n— Mentor Menolak Rugi 🏆`;
        await channel.send(msg);
        sent++;
        // Delay 1.5 detik antar pesan biar tidak kena rate limit Discord
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.error(`Gagal kirim ke ${m.nama}:`, e.message);
      }
    }
    res.json({ success: true, sent, total: members.length });
  } catch (err) {
    console.error('Congrats all error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

const PORT = process.env.SERVER_PORT || process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
