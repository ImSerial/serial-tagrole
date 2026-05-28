const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    Partials
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();
require("dotenv").config();


const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || "1133246357960921158";

if (!TOKEN || !CLIENT_ID) {
    console.error("❌ TOKEN ou CLIENT_ID manquant dans .env");
    process.exit(1);
}

console.log("🔄 Démarrage du bot...");


const db = new sqlite3.Database("./database.sqlite");

db.serialize(() => {
    db.run(
        `CREATE TABLE IF NOT EXISTS tag_roles (
            guild_id TEXT PRIMARY KEY,
            role_id TEXT NOT NULL
        )`,
        (err) => {
            if (err) console.error("❌ SQLite error:", err);
            else console.log("✅ Table SQLite OK");
        }
    );
});

function setGuildRole(guildId, roleId) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO tag_roles (guild_id, role_id)
             VALUES (?, ?)
             ON CONFLICT(guild_id) DO UPDATE SET role_id = excluded.role_id`,
            [guildId, roleId],
            (err) => (err ? reject(err) : resolve())
        );
    });
}

function getGuildRole(guildId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT role_id FROM tag_roles WHERE guild_id = ?`,
            [guildId],
            (err, row) => (err ? reject(err) : resolve(row ? row.role_id : null))
        );
    });
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.GuildMember],
});

// Cache des états tag
const tagStatusCache = new Map();


async function registerCommands() {
    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    const commands = [{
            name: "role",
            description: "Configure le rôle donné à ceux qui équipent le tag du serveur",
            options: [{
                type: 8,
                name: "role",
                description: "Choisis le rôle récompense",
                required: true,
            }, ],
        },
        {
            name: "sync",
            description: "Forcer la synchronisation complète (scan total)"
        }
    ];

    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), {
            body: commands
        });
        console.log("✅ Commandes enregistrées !");
    } catch (err) {
        console.error("❌ Erreur en enregistrant les commandes :", err);
    }
}


client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "role") {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({
                content: "⛔ Commande réservée au propriétaire du bot.",
                ephemeral: true,
            });
        }

        const role = interaction.options.getRole("role", true);
        await setGuildRole(interaction.guild.id, role.id);

        const memberCount = interaction.guild.memberCount;
        const estimatedSeconds = Math.ceil(memberCount / 50);

        await interaction.reply({
            content: `💾 Le rôle <@&${role.id}> a été configuré.\n` +
                `🔄 Synchronisation complète en cours...\n` +
                `⏳ Estimation : **~${estimatedSeconds} secondes** pour ${memberCount} membres.`,
            ephemeral: true,
        });

        console.log(`💾 Config: guild ${interaction.guild.id} -> role ${role.id}`);
        await refreshAllMembers(interaction.guild);

        return;
    }

    if (interaction.commandName === "sync") {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({
                content: "⛔ Commande réservée au propriétaire du bot.",
                ephemeral: true,
            });
        }

        const memberCount = interaction.guild.memberCount;
        const estimatedSeconds = Math.ceil(memberCount / 50);

        await interaction.reply({
            content: `🔄 Synchronisation complète lancée...\n` +
                `⏳ Estimation : **~${estimatedSeconds} secondes** pour ${memberCount} membres.`,
            ephemeral: true,
        });

        await refreshAllMembers(interaction.guild);

        return;
    }
});


async function refreshAllMembers(guild) {
    console.log(`🔄 Scan du serveur "${guild.name}" (${guild.id})...`);

    const roleId = await getGuildRole(guild.id);
    if (!roleId) {
        console.log("⚠ Aucun rôle configuré pour cette guilde.");
        return;
    }

    const role = guild.roles.cache.get(roleId);
    if (!role) {
        console.log("❌ Rôle introuvable !");
        return;
    }

    const members = await guild.members.fetch();
    const rest = new REST({
        version: "10"
    }).setToken(TOKEN);

    for (const [memberId, member] of members) {
        try {
            const userData = await rest.get(Routes.user(memberId));

            const hasTag =
                userData.primary_guild?.identity_guild_id === guild.id;

            const cacheKey = `${guild.id}:${memberId}`;
            tagStatusCache.set(cacheKey, hasTag);

            const hasRole = member.roles.cache.has(roleId);

            if (hasTag && !hasRole) {
                console.log(`🟢 Ajout du rôle → ${memberId}`);
                await member.roles.add(roleId).catch(console.error);
            }

            if (!hasTag && hasRole) {
                console.log(`🔴 Retrait du rôle → ${memberId}`);
                await member.roles.remove(roleId).catch(console.error);
            }

        } catch (err) {
            console.log(`⚠ Erreur fetch user ${memberId}:`, err.message);
        }
    }

    console.log("✅ Scan terminé !");
}


client.on("raw", async (packet) => {
    if (packet.t !== "GUILD_MEMBER_UPDATE") return;

    const data = packet.d;
    const guildId = data.guild_id;
    const user = data.user;

    if (!guildId || !user) return;

    const userId = user.id;
    const identityGuildId = user.primary_guild?.identity_guild_id || null;
    const hasTag = identityGuildId === guildId;

    const cacheKey = `${guildId}:${userId}`;
    const previous = tagStatusCache.has(cacheKey) ?
        tagStatusCache.get(cacheKey) :
        null;

    tagStatusCache.set(cacheKey, hasTag);

    console.log("=====================================");
    console.log("📡 GUILD_MEMBER_UPDATE");
    console.log("User:", userId);
    console.log("Tag actif:", hasTag);
    console.log("Ancien état:", previous);
    console.log("=====================================");

    if (previous !== null && previous === hasTag) return;

    const roleId = await getGuildRole(guildId);
    if (!roleId) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const hasRole = member.roles.cache.has(roleId);

    if (hasTag && !hasRole) {
        console.log(`🟢 Ajout du rôle → ${userId}`);
        member.roles.add(roleId).catch(console.error);
    }

    if (!hasTag && hasRole) {
        console.log(`🔴 Retrait du rôle → ${userId}`);
        member.roles.remove(roleId).catch(console.error);
    }
});


client.once("ready", async () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);
    await registerCommands();

    for (const [guildId, guild] of client.guilds.cache) {
        refreshAllMembers(guild);
    }
});

client.login(TOKEN).catch((err) => {
    console.error("❌ Erreur de connexion :", err);
});
