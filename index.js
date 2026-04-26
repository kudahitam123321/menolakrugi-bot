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
  res.json(result);
});

// Health check
app.get('/', (req, res) => res.json({ status: 'MenolakRugi Bot is running!' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
