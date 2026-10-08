require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// ---------------- 1. EXPRESS HTTP SERVER & PING ROUTES ----------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.status(200).send("PP MOD Master Engine Active!"));
app.get("/ping", (req, res) => res.status(200).send("pong"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));
app.listen(PORT, () => console.log(`[HTTP] Server active on port ${PORT}`));

// ---------------- 2. FIREBASE ADMIN ----------------
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    serviceAccount = require("./serviceAccountKey.json");
}
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------------- 3. CONFIGURATIONS ----------------
const DEFAULT_API_ID = Number(process.env.TELEGRAM_API_ID || 29630945);
const DEFAULT_API_HASH = process.env.TELEGRAM_API_HASH || "11b73fd133a7e3edea8d683aec494d3e";
const TARGET_BOT = process.env.TARGET_BOT || "PlayQuestHelperBot";

const USER_NOTIFY_BOT_TOKEN = process.env.USER_NOTIFY_BOT_TOKEN || "8906230491:AAEu4CX0T9Dz6YMLxeCNz6U-nbiQmiBiJ_s";
const GROUP_PROTECT_BOT_TOKEN = process.env.GROUP_PROTECT_BOT_TOKEN || "8590481969:AAFezVtaNE6D0QF0ss26k2SHj5tW7hCiSN8";
const ORDER_LOG_CHANNEL = process.env.ORDER_LOG_CHANNEL || "@ppmododderlog";

const groupBot = new TelegramBot(GROUP_PROTECT_BOT_TOKEN, { polling: true });
const userNotifyBot = new TelegramBot(USER_NOTIFY_BOT_TOKEN, { polling: true });

const WELCOME_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791346466943_file_00000000702c82118797af8f3a1c57e0.png";
const PRIME_AUTO_REPLY_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791345238749_file_000000003d348211a5a894b5cf98d67c.png";
const PRIME_AUTO_REPLY_CAPTION = `👋 <b>হ্যালো!</b>\n\nএডমিন অনলাইনে আসলে আপনার মেসেজের রিপ্লাই দেওয়া হবে। আপনার কী প্রয়োজন তা দয়া করে নিচে বিস্তারিত লিখে রাখুন।\n\n📢 <b>আমাদের অফিসিয়াল চ্যানেলে যুক্ত থাকুন:</b>\n👉 <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n\nধন্যবাদ! ✨`;

let currentClient = null;
let currentPhone = null;
let primeClient = null;
let primePhone = null;

const activeOrders = new Set();
const autoReplyCooldown = new Map();
const pendingAuthClients = new Map();
const groupConfigs = new Map();
const userWarnings = new Map(); // "chatId:userId" -> warningCount
const lastWelcomeMessages = new Map(); // chatId -> messageId

// ইনবক্স ও প্রমোশন শব্দ
const INBOX_WORDS = ["inbox", "ib", "dm me", "pm me", "message me", "msg me", "আমায় মেসেজ করো", "ইনবক্সে আসো", "ইনবক্স", "ইনবক্সে", "নক দাও", "নক দিন", "পার্সোনালে আসো"];

// আসল গালি তালিকা (বাংলা ও বাংলিশ)
const REAL_BAD_WORDS = [
    "madarchod", "madarshod", "mc", "bc", "bessha", "khanki", "magi", "chudi", "chuda",
    "chudo", "balsal", "baler", "suor", "kutta", "gandu", "harami", "bokachoda", "chodar",
    "chudte", "malai", "dimaon", "মাদারচোদ", "খানকি", "মাগী", "চোদা", "চুদি", "বাল",
    "শুয়োর", "কুত্তা", "হারামি", "বোকাচোদা", "চোদ", "বেশ্যা", "খানকিরপোল"
];

function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) return "+" + num;
    if (num.startsWith("0")) return "+88" + num;
    if (num.startsWith("1")) return "+880" + num;
    return "+" + num;
}

// ---------------- 3b. USER BOT REFERRAL & FORCED JOIN SYSTEM (@Ppmod_bot) ----------------
const REQUIRED_CHANNELS = [
    { name: "📢 Main Channel", url: "https://t.me/googleplaypointhack", username: "@googleplaypointhack" },
    { name: "📋 All Order Log", url: "https://t.me/ppmododderlog", username: "@ppmododderlog" },
    { name: "💬 Community Group", url: "https://t.me/GPPHMCOMMUNITY", username: "@GPPHMCOMMUNITY" },
    { name: "🔒 Private Channel (Request)", url: "https://t.me/+s09ahNjWHZM4YWM9", invite: true }
];

function generateReferralCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let randomPart = "";
    for (let i = 0; i < 6; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `PPM-REF-${randomPart}`;
}

async function checkUserMembership(userId) {
    for (const ch of REQUIRED_CHANNELS) {
        if (!ch.username) continue;
        try {
            const member = await userNotifyBot.getChatMember(ch.username, userId);
            const valid = ["creator", "administrator", "member", "restricted"].includes(member.status);
            if (!valid) return false;
        } catch (e) {
            // যদি বট কোনো চ্যানেলে অ্যাডমিন না থাকে তবে স্কিপ করবে
        }
    }
    return true;
}

function getJoinKeyboard(userId, refId = null) {
    const rows = REQUIRED_CHANNELS.map((ch, idx) => [
        { text: `${idx + 1}. ${ch.name}`, url: ch.url }
    ]);
    const verifyData = refId ? `verify_ref:${refId}` : "verify_ref:none";
    rows.push([{ text: "✅ Verify / চেক করুন", callback_data: verifyData }]);
    rows.push([{ text: "👥 আমার রেফারেল লিংক ও পরিসংখ্যান", callback_data: "my_ref_info" }]);
    return { inline_keyboard: rows };
}

// /start command handler for @Ppmod_bot
userNotifyBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const startParam = (match && match[1]) ? match[1].trim() : "";
        let inviterId = null;

        if (startParam.startsWith("ref_")) {
            inviterId = startParam.replace("ref_", "").trim();
            if (inviterId === userId) inviterId = null; // নিজের রেফার নিজে নয়
        }

        const userDoc = await db.collection("tg_bot_users").doc(userId).get();
        if (!userDoc.exists) {
            await db.collection("tg_bot_users").doc(userId).set({
                id: userId,
                name: `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim(),
                username: msg.from.username ? `@${msg.from.username}` : "",
                inviterId: inviterId || null,
                isVerified: false,
                referralCount: 0,
                rewardsEarned: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } else if (!userDoc.data().isVerified && inviterId && !userDoc.data().inviterId) {
            await db.collection("tg_bot_users").doc(userId).update({ inviterId });
        }

        const welcomeText = 
            `👋 <b>হ্যালো ${msg.from.first_name || "ইউজার"}!</b>\n\n` +
            `PP MOD অফিসিয়াল বটে আপনাকে স্বাগতম। 🚀\n\n` +
            `🎁 <b>স্পেশাল রেফারেল অফার:</b>\n` +
            `প্রতি <b>১০ জন সফল রেফারে</b> আপনি পাবেন একটি <b>৩ PP Coins</b>-এর ফ্রি রিডিম কোড!\n\n` +
            `⚠️ <b>বট অ্যাক্টিভ ও রেফার কাউন্ট হতে নিচের ৪টি লিংকেই জয়েন ও রিকোয়েস্ট পাঠান:</b>\n` +
            `১. <a href="https://t.me/googleplaypointhack">Main Channel</a>\n` +
            `২. <a href="https://t.me/ppmododderlog">All Order Log</a>\n` +
            `৩. <a href="https://t.me/GPPHMCOMMUNITY">Community Group</a>\n` +
            `৪. <a href="https://t.me/+s09ahNjWHZM4YWM9">Private Channel (Request Join)</a>\n\n` +
            `সবগুলোতে জয়েন করে নিচের <b>"Verify / চেক করুন"</b> বাটনে চাপ দিন।`;

        await userNotifyBot.sendMessage(chatId, welcomeText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: getJoinKeyboard(userId, inviterId)
        });
    } catch (e) {
        console.error("[USER BOT START ERR]:", e.message);
    }
});

// Callback Query Handler (Verification & Referral Stats)
userNotifyBot.on("callback_query", async (query) => {
    try {
        const chatId = query.message.chat.id;
        const userId = query.from.id.toString();
        const data = query.data || "";

        if (data.startsWith("verify_ref:")) {
            const isAllJoined = await checkUserMembership(userId);
            if (!isAllJoined) {
                return userNotifyBot.answerCallbackQuery(query.id, {
                    text: "❌ আপনি সবগুলো চ্যানেলে জয়েন করেননি! সবগুলোতে জয়েন করে আবার চাপুন।",
                    show_alert: true
                });
            }

            const userRef = db.collection("tg_bot_users").doc(userId);
            const userSnap = await userRef.get();
            const userData = userSnap.exists ? userSnap.data() : {};

            if (userData.isVerified) {
                return userNotifyBot.answerCallbackQuery(query.id, {
                    text: "✅ আপনি ইতিমধ্যে ভেরিফাইড!",
                    show_alert: true
                });
            }

            // মার্ক ইউজার এজ ভেরিফাইড
            await userRef.set({
                isVerified: true,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            await userNotifyBot.answerCallbackQuery(query.id, {
                text: "🎉 সফলভাবে ভেরিফিকেশন সম্পন্ন হয়েছে!",
                show_alert: true
            });

            await userNotifyBot.sendMessage(chatId, 
                `✅ <b>ভেরিফিকেশন সফল হয়েছে!</b>\n\nএখন থেকে আপনি রেফার করে রিডিম কোড জিততে পারবেন এবং সমস্ত আপডেট সরাসরি পাবেন।`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "👥 আমার রেফারেল লিংক দেখুন", callback_data: "my_ref_info" }]
                        ]
                    }
                }
            );

            // ইনভাইটারকে রেফারেল পয়েন্ট ও রিওয়ার্ড প্রদান
            const inviterId = userData.inviterId;
            if (inviterId) {
                const inviterRef = db.collection("tg_bot_users").doc(inviterId);
                const inviterSnap = await inviterRef.get();

                if (inviterSnap.exists) {
                    const invData = inviterSnap.data();
                    const newCount = (Number(invData.referralCount) || 0) + 1;
                    const prevRewards = Number(invData.rewardsEarned) || 0;
                    const eligibleRewards = Math.floor(newCount / 10);

                    await inviterRef.update({ referralCount: newCount });

                    // ইনভাইটারকে প্রগ্রেস নোটিফিকেশন
                    const remaining = 10 - (newCount % 10 === 0 ? 0 : newCount % 10);
                    await userNotifyBot.sendMessage(inviterId,
                        `🎉 <b>নতুন রেফার সম্পন্ন হয়েছে!</b>\n\n` +
                        `👤 <a href="tg://user?id=${userId}">${query.from.first_name || "User"}</a> আপনার লিংকে সফলভাবে ভেরিফাই হয়েছে।\n\n` +
                        `👥 মোট সফল রেফার: <b>${newCount}</b> জন\n` +
                        `🎯 পরবর্তী ৩ কয়েন রিডিম কোডের জন্য আর <b>${remaining === 0 ? 10 : remaining}</b> জন রেফার প্রয়োজন!`,
                        { parse_mode: "HTML" }
                    ).catch(() => {});

                    // ১০টি রেফার পূর্ণ হলে ৩ কয়েনের রিডিম কোড জেনারেশন
                    if (eligibleRewards > prevRewards) {
                        const newRewardCount = eligibleRewards - prevRewards;
                        for (let i = 0; i < newRewardCount; i++) {
                            const newCode = generateReferralCode();

                            await db.collection("codes").doc(newCode).set({
                                amount: 3,
                                maxUses: 1,
                                used: 0,
                                active: true,
                                note: "Referral Bonus: 10 Referrals Completed!",
                                createdAt: admin.firestore.FieldValue.serverTimestamp()
                            });

                            await userNotifyBot.sendMessage(inviterId,
                                `🎁 <b>অভিনন্দন! আপনার ১০টি সফল রেফার সম্পন্ন হয়েছে!</b>\n\n` +
                                `আপনার ৩ কয়েন রিডিম কোড:\n<code>${newCode}</code>\n\n` +
                                `👉 এখনই PP MOD অ্যাপ ওপেন করে <b>Profile > Redeem Code</b> বক্সে কোডটি দিয়ে ৩টি PP Coins ক্লেইম করে নিন! ✨`,
                                { parse_mode: "HTML" }
                            ).catch(() => {});
                        }

                        await inviterRef.update({ rewardsEarned: eligibleRewards });
                    }
                }
            }
            return;
        }

        if (data === "my_ref_info") {
            const userSnap = await db.collection("tg_bot_users").doc(userId).get();
            const uData = userSnap.exists ? userSnap.data() : {};
            const refCount = Number(uData.referralCount) || 0;
            const rewards = Number(uData.rewardsEarned) || 0;
            const needed = 10 - (refCount % 10 === 0 && refCount > 0 ? 0 : refCount % 10);
            const botInfo = await userNotifyBot.getMe();
            const refLink = `https://t.me/${botInfo.username}?start=ref_${userId}`;

            const infoMsg = 
                `👥 <b>আপনার রেফারেল ড্যাশবোর্ড</b>\n\n` +
                `🔗 <b>আপনার রেফারেল লিংক:</b>\n<code>${refLink}</code>\n\n` +
                `📊 <b>মোট সফল রেফার:</b> ${refCount} জন\n` +
                `🎁 <b>মোট প্রাপ্ত রিডিম কোড:</b> ${rewards} টি\n` +
                `🎯 <b>পরবর্তী কোডের জন্য বাকি:</b> ${needed === 0 ? 10 : needed} জন\n\n` +
                `<i>আপনার রেফারেল লিংক বন্ধুদের মাঝে শেয়ার করুন এবং প্রতি ১০ জন ভেরিফাইড রেফারে জিতে নিন ৩ কয়েন ফ্রি রিডিম কোড!</i>`;

            await userNotifyBot.answerCallbackQuery(query.id);
            await userNotifyBot.sendMessage(chatId, infoMsg, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📤 শেয়ার করুন", url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent("PP MOD-এ জয়েন করুন এবং জিতে নিন ফ্রি গুগল প্লে পয়েন্ট কয়েন!")}` }]
                    ]
                }
            });
            return;
        }
    } catch (e) {
        console.error("[USER BOT CB ERR]:", e.message);
    }
});

// ---------------- 4. BROADCAST TO ALL GROUPS API ----------------
app.post("/api/tg/group-broadcast", async (req, res) => {
    const { text, photoUrl, chatId } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: "মেসেজ লিখুন" });

    try {
        let targets = [];
        if (chatId) {
            targets = [chatId.toString()];
        } else {
            const snap = await db.collection("tg_groups").get();
            snap.forEach((d) => targets.push(d.id));
        }
        let successCount = 0;

        for (const targetId of targets) {
            try {
                if (photoUrl) {
                    await groupBot.sendPhoto(targetId, photoUrl, { caption: text, parse_mode: "HTML" });
                } else {
                    await groupBot.sendMessage(targetId, text, { parse_mode: "HTML" });
                }
                successCount++;
            } catch (err) {}
        }
        return res.json({ ok: true, message: `${successCount} টি গ্রুপে ব্রডকাস্ট পাঠানো হয়েছে!` });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 4b. GLOBAL WELCOME DEFAULTS (tg_config/welcome, cached 5 min) ----------------
let globalWelcome = null, globalWelcomeAt = 0;
async function getGlobalWelcome() {
    if (globalWelcome && Date.now() - globalWelcomeAt < 5 * 60 * 1000) return globalWelcome;
    try {
        const d = await db.collection("tg_config").doc("welcome").get();
        globalWelcome = d.exists ? d.data() : {};
    } catch (e) { globalWelcome = globalWelcome || {}; }
    globalWelcomeAt = Date.now();
    return globalWelcome;
}
function buildWelcome(gw, name) {
    gw = gw || {};
    const text = gw.welcomeMsg ? String(gw.welcomeMsg).replace(/\{name\}/g, name || "Member")
        : `🎉 <b>স্বাগতম ${name || "Member"}!</b>\n\n` +
          `আমাদের অফিসিয়াল গ্রুপে আপনাকে স্বাগতম। এখানে গুগল প্লে পয়েন্ট অটোমেশন সাপোর্ট ও রিয়েল-টাইম আপডেট পাবেন।\n\n` +
          `📢 <b>আমাদের চ্যানেল:</b> <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n` +
          `⚠️ <i>গ্রুপে যেকোনো স্ক্যামার থেকে সতর্ক থাকুন।</i>`;
    const img = gw.welcomeImg || WELCOME_IMG;
    const links = (Array.isArray(gw.joinLinks) && gw.joinLinks.length)
        ? gw.joinLinks
        : [{ text: "📢 Official Channel", url: "https://t.me/googleplaypointhack" }];
    const buttons = links.filter((b) => b && b.url).slice(0, 8).map((b) => ([
        { text: String(b.text || "Join").slice(0, 60), url: String(b.url) }
    ]));
    return { text, img, buttons };
}

app.post("/api/tg/test-welcome", async (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ ok: false, error: "Group ID দিন" });
    try {
        const gw = await getGlobalWelcome();
        const w = buildWelcome(gw, "Test User");
        await groupBot.sendPhoto(chatId.toString(), w.img, {
            caption: w.text, parse_mode: "HTML", reply_markup: { inline_keyboard: w.buttons }
        });
        return res.json({ ok: true, message: "Welcome preview পাঠানো হয়েছে!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 5. DETAILED GIVEAWAY API ----------------
app.post("/api/tg/create-giveaway", async (req, res) => {
    const { chatId, title, itemName, amount, winnersCount } = req.body;
    if (!chatId || !title || !itemName) return res.status(400).json({ ok: false, error: "সবগুলো তথ্য পূরণ করুন" });

    try {
        const giveawayRef = await db.collection("giveaways").add({
            chatId,
            title,
            itemName,
            amount: amount || "",
            winnersCount: Number(winnersCount || 1),
            participants: [],
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const gMsg = await groupBot.sendMessage(chatId, 
            `🎉 <b>${title}</b>\n\n` +
            `🎁 <b>পুরস্কার:</b> ${amount ? amount + " " : ""}${itemName}\n` +
            `🏆 <b>বিজয়ী নির্বাচন:</b> ${winnersCount} জন\n\n` +
            `👇 নিচের বাটনে চাপ দিয়ে এখনই অংশগ্রহণ করুন!`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `🎉 Join Giveaway [0]`, callback_data: `giveaway_join:${giveawayRef.id}` }]
                    ]
                }
            }
        );
        await groupBot.pinChatMessage(chatId, gMsg.message_id).catch(() => {});

        await giveawayRef.update({ messageId: gMsg.message_id });
        return res.json({ ok: true, message: "গিভঅ্যাওয়ে পোস্ট করা হয়েছে!", giveawayId: giveawayRef.id });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/end-giveaway", async (req, res) => {
    const { giveawayId } = req.body;
    try {
        const gDoc = await db.collection("giveaways").doc(giveawayId).get();
        if (!gDoc.exists) return res.status(404).json({ ok: false, error: "Giveaway not found" });

        const g = gDoc.data();
        if (g.status === "ended") return res.status(400).json({ ok: false, error: "ইতিমধ্যে সমাপ্ত হয়েছে" });

        const participants = g.participants || [];
        if (participants.length === 0) {
            await groupBot.sendMessage(g.chatId, `⚠️ <b>${g.title} সমাপ্ত:</b> কোনো অংশগ্রহণকারী পাওয়া যায়নি।`, { parse_mode: "HTML" });
            await gDoc.ref.update({ status: "ended" });
            return res.json({ ok: true, message: "No participants" });
        }

        const shuffled = participants.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, Math.min(g.winnersCount, participants.length));

        let winnerText = `🏆 <b>গিভঅ্যাওয়ে ফলাফল ও বিজয়ীদের তালিকা!</b>\n\n🎉 <b>${g.title}</b>\n🎁 <b>পুরস্কার:</b> ${g.amount ? g.amount + " " : ""}${g.itemName}\n\n`;
        winners.forEach((w, idx) => {
            winnerText += `🥇 <b>Winner ${idx + 1}:</b> <a href="tg://user?id=${w.id}">${w.name}</a> (<code>${w.id}</code>)\n`;
        });
        winnerText += `\n🎉 অভিনন্দন সবাইকে! এডমিনের সাথে যোগাযোগ করে পুরস্কার সংগ্রহ করুন।`;

        await groupBot.sendMessage(g.chatId, winnerText, { parse_mode: "HTML" });
        await groupBot.unpinChatMessage(g.chatId).catch(() => {});
        await gDoc.ref.update({ status: "ended", winners });

        return res.json({ ok: true, winners });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 6. DEDICATED 24/7 PRIME AUTO-RESPONDER ----------------
async function initPrimeAutoResponder() {
    try {
        const snap = await db.collection("tg_accounts").where("isPrime", "==", true).limit(1).get();
        if (snap.empty) return;
        const primeData = snap.docs[0].data();
        const phone = primeData.phone || snap.docs[0].id;
        if (primeClient && primePhone === phone) return;

        if (primeClient) {
            try { await primeClient.disconnect(); } catch (e) {}
        }

        primeClient = new TelegramClient(new StringSession(primeData.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 10 });
        await primeClient.connect();
        primePhone = phone;

        primeClient.addEventHandler(async (event) => {
            try {
                const msg = event.message;
                if (!msg || msg.out || !event.isPrivate) return;
                const sender = await msg.getSender();
                if (!sender || sender.bot) return;

                const senderId = sender.id.toString();
                if (!(await primeCooldownClaim(senderId))) return;

                await new Promise((r) => setTimeout(r, 3500));
                await primeClient.sendMessage(sender.id, {
                    file: PRIME_AUTO_REPLY_IMG,
                    message: PRIME_AUTO_REPLY_CAPTION,
                    parseMode: "html"
                });
            } catch (err) {}
        }, new NewMessage({ incoming: true }));
    } catch (e) {}
}

// Prime auto-reply cooldown: Firestore-backed (survives Render restarts), 60 min per user
async function primeCooldownClaim(senderId) {
    try {
        const ref = db.collection("tg_autoreply").doc(senderId);
        const snap = await ref.get();
        const last = snap.exists ? Number(snap.data().lastAt || 0) : 0;
        if (Date.now() - last < 3600000) return false;
        await ref.set({ lastAt: Date.now() }, { merge: true });
        return true;
    } catch (e) {
        const last = autoReplyCooldown.get(senderId) || 0;
        if (Date.now() - last < 3600000) return false;
        autoReplyCooldown.set(senderId, Date.now());
        return true;
    }
}

// Warn counter: Firestore-backed (survives restarts) + memory fast-path
async function getWarnCount(chatId, userId) {
    try {
        const w = await db.collection("tg_warns").doc(`${chatId}:${userId}`).get();
        if (w.exists) return Number(w.data().count || 0);
    } catch (e) {}
    return userWarnings.get(`${chatId}:${userId}`) || 0;
}
async function setWarnCount(chatId, userId, n) {
    userWarnings.set(`${chatId}:${userId}`, n);
    try {
        await db.collection("tg_warns").doc(`${chatId}:${userId}`).set({
            chatId, userId, count: n, updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {}
}
async function clearWarn(chatId, userId) {
    userWarnings.delete(`${chatId}:${userId}`);
    try { await db.collection("tg_warns").doc(`${chatId}:${userId}`).delete(); } catch (e) {}
}

// ---------------- 7. FAST DIRECT OTP API ----------------
app.post("/api/tg/send-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    if (!phone || phone.length < 11) return res.status(400).json({ ok: false, error: "সঠিক ফোন নম্বর দিন" });

    try {
        const tempClient = new TelegramClient(new StringSession(""), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
        await tempClient.connect();
        const result = await tempClient.sendCode({ apiId: DEFAULT_API_ID, apiHash: DEFAULT_API_HASH }, phone);
        pendingAuthClients.set(phone, { client: tempClient, phoneCodeHash: result.phoneCodeHash });
        return res.json({ ok: true, message: "OTP sent!", phone });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Universal 2FA SRP Calculator Helper
async function computeSrpHash(client, password) {
    let computeFn = null;
    const paths = ["telegram/Password", "telegram/Password.js", "telegram/Utils"];
    for (const p of paths) {
        try {
            const mod = require(p);
            if (typeof mod === "function") { computeFn = mod; break; }
            if (typeof mod.computeCheckPassword === "function") { computeFn = mod.computeCheckPassword; break; }
            if (mod.default) {
                if (typeof mod.default === "function") { computeFn = mod.default; break; }
                if (typeof mod.default.computeCheckPassword === "function") { computeFn = mod.default.computeCheckPassword; break; }
            }
            for (const k of Object.keys(mod)) {
                if (typeof mod[k] === "function" && k.toLowerCase().includes("password")) {
                    computeFn = mod[k];
                    break;
                }
            }
            if (computeFn) break;
        } catch (e) {}
    }

    if (!computeFn) {
        try {
            const gram = require("telegram");
            if (typeof gram.computeCheckPassword === "function") computeFn = gram.computeCheckPassword;
            else if (gram.Password && typeof gram.Password.computeCheckPassword === "function") computeFn = gram.Password.computeCheckPassword;
        } catch (e) {}
    }

    const srpResult = await client.invoke(new Api.account.GetPassword());
    if (computeFn) {
        return await computeFn(srpResult, password);
    }
    throw new Error("2FA Password module resolution failed");
}

app.post("/api/tg/verify-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    const code = (req.body.code || "").toString().trim();
    const password = (req.body.password || "").toString().trim();

    const item = pendingAuthClients.get(phone);
    if (!item) return res.status(400).json({ ok: false, error: "সেশন মেয়াদ শেষ!" });

    try {
        try {
            await item.client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: item.phoneCodeHash,
                phoneCode: code
            }));
        } catch (signInErr) {
            if (signInErr.errorMessage === "SESSION_PASSWORD_NEEDED" || (signInErr.message && (signInErr.message.includes("2FA") || signInErr.message.includes("PASSWORD")))) {
                if (!password) return res.status(400).json({ ok: false, error: "Two-Step পাসওয়ার্ড দিন" });

                const passwordSrpHash = await computeSrpHash(item.client, password);
                await item.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpHash }));
            } else {
                throw signInErr;
            }
        }

        const sessionString = item.client.session.save();
        await db.collection("tg_accounts").doc(phone).set({
            phone, session: sessionString, balance: 0, active: true, addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        pendingAuthClients.delete(phone);
        return res.json({ ok: true, message: "Account connected successfully!" });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message });
    }
});

// ---------------- 7b. DIRECT QR CODE LOGIN API ----------------
const activeQrClients = new Map();

app.post("/api/tg/qr-start", async (req, res) => {
    try {
        const qrId = "qr_" + Date.now();
        const client = new TelegramClient(new StringSession(""), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
        await client.connect();

        const result = await client.invoke(new Api.auth.ExportLoginToken({
            apiId: DEFAULT_API_ID,
            apiHash: DEFAULT_API_HASH,
            exceptIds: []
        }));

        if (result && result.token) {
            const tokenBase64 = Buffer.from(result.token).toString("base64url");
            const qrUrl = `tg://login?token=${tokenBase64}`;
            activeQrClients.set(qrId, { client, expires: result.expires });
            return res.json({ ok: true, qrId, qrUrl, expires: result.expires });
        }
        return res.status(400).json({ ok: false, error: "QR জেনারেট ফেইলড" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/qr-check", async (req, res) => {
    const { qrId, password } = req.body;
    const item = activeQrClients.get(qrId);
    if (!item) return res.status(400).json({ ok: false, error: "QR এর মেয়াদ শেষ" });

    try {
        const result = await item.client.invoke(new Api.auth.ExportLoginToken({
            apiId: DEFAULT_API_ID,
            apiHash: DEFAULT_API_HASH,
            exceptIds: []
        }));

        if (result instanceof Api.auth.LoginTokenSuccess) {
            const me = await item.client.getMe();
            const phone = me.phone ? formatBdPhone(me.phone) : `+${me.id}`;
            const sessionString = item.client.session.save();

            await db.collection("tg_accounts").doc(phone).set({
                phone, session: sessionString, balance: 0, active: true, addedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            activeQrClients.delete(qrId);
            return res.json({ ok: true, status: "success", phone });
        } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
            // ডাটা সেন্টার মাইগ্রেশন (Asia/BD অ্যাকাউন্ট হলে প্রয়োজন হয়)
            await item.client._switchDC(result.dcId);
            return res.json({ ok: true, status: "pending" });
        }
        return res.json({ ok: true, status: "pending" });
    } catch (e) {
        if (e.errorMessage === "SESSION_PASSWORD_NEEDED" || (e.message && e.message.includes("2FA"))) {
            if (!password) {
                return res.json({ ok: true, status: "2fa_needed" });
            }
            try {
                const srpHash = await computeSrpHash(item.client, password);
                await item.client.invoke(new Api.auth.CheckPassword({ password: srpHash }));

                const me = await item.client.getMe();
                const phone = me.phone ? formatBdPhone(me.phone) : `+${me.id}`;
                const sessionString = item.client.session.save();

                await db.collection("tg_accounts").doc(phone).set({
                    phone, session: sessionString, balance: 0, active: true, addedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                activeQrClients.delete(qrId);
                return res.json({ ok: true, status: "success", phone });
            } catch (err2) {
                return res.status(400).json({ ok: false, error: "Two-Step পাসওয়ার্ড ভুল হয়েছে" });
            }
        }
        return res.json({ ok: true, status: "pending" });
    }
});

// ---------------- 8. REAL BALANCE AUDIT API ----------------
app.post("/api/tg/check-balance", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট পুলে নেই" });

        let totalBalance = 0;
        const results = [];

        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            try {
                const tempClient = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
                await tempClient.connect();
                await tempClient.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });
                await new Promise((r) => setTimeout(r, 2500));

                const msgs = await tempClient.getMessages(TARGET_BOT, { limit: 1 });
                let b = null;
                if (msgs && msgs.length > 0) b = parseBotBalance(msgs[0].message);

                if (b !== null) {
                    await db.collection("tg_accounts").doc(docSnap.id).update({
                        balance: b, lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    totalBalance += b;
                    results.push({ phone, balance: b });
                } else {
                    results.push({ phone, balance: acc.balance || 0 });
                }
                await tempClient.disconnect();
            } catch (err) {
                results.push({ phone, balance: acc.balance || 0 });
            }
        }

        await db.collection("config").doc("app").set({
            botTokensTotal: totalBalance, botTokensLastSync: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, total: totalBalance, accounts: results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 8b. MASS PROMO CODE REDEEM & AUTO DAILY CLAIM ----------------
async function claimDailySingle(sessionStr) {
    const temp = new TelegramClient(new StringSession(sessionStr), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
    await temp.connect();
    try {
        await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
        await new Promise((r) => setTimeout(r, 2000));
        const msgs = await temp.getMessages(TARGET_BOT, { limit: 1 });
        if (msgs && msgs.length > 0) {
            const clicked = await clickInlineButton(msgs[0], "Claim Today");
            if (clicked) {
                await new Promise((r) => setTimeout(r, 2000));
                const resMsgs = await temp.getMessages(TARGET_BOT, { limit: 1 });
                return { ok: true, message: resMsgs[0] ? resMsgs[0].message : "Claimed!" };
            }
        }
        return { ok: false, message: "Claim button not found or already claimed today" };
    } finally {
        try { await temp.disconnect(); } catch (e) {}
    }
}

async function redeemPromoSingle(sessionStr, code) {
    const temp = new TelegramClient(new StringSession(sessionStr), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
    await temp.connect();
    try {
        await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
        await new Promise((r) => setTimeout(r, 2000));
        const msgs = await temp.getMessages(TARGET_BOT, { limit: 1 });
        if (!msgs || !msgs.length) return { ok: false, message: "Rewards Hub load failed" };

        const clicked = await clickInlineButton(msgs[0], "Redeem Promo");
        if (!clicked) return { ok: false, message: "Redeem Promo button not found" };

        await new Promise((r) => setTimeout(r, 2000));
        await temp.sendMessage(TARGET_BOT, { message: code });
        await new Promise((r) => setTimeout(r, 2500));

        const resMsgs = await temp.getMessages(TARGET_BOT, { limit: 1 });
        const replyText = resMsgs && resMsgs[0] ? resMsgs[0].message : "Code sent";
        return { ok: true, message: replyText };
    } finally {
        try { await temp.disconnect(); } catch (e) {}
    }
}

app.post("/api/tg/claim-daily-all", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").where("active", "==", true).get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাক্টিভ অ্যাকাউন্ট নেই" });

        const results = [];
        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            try {
                const claimRes = await claimDailySingle(acc.session);
                results.push({ phone, ...claimRes });
            } catch (err) {
                results.push({ phone, ok: false, message: err.message });
            }
            await new Promise((r) => setTimeout(r, 1500)); // Rate limit prevention
        }
        return res.json({ ok: true, results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/redeem-code-all", async (req, res) => {
    const code = (req.body.code || "").toString().trim();
    if (!code) return res.status(400).json({ ok: false, error: "প্রোমো কোডটি দিন" });

    try {
        const snap = await db.collection("tg_accounts").where("active", "==", true).get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাক্টিভ অ্যাকাউন্ট নেই" });

        const results = [];
        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            try {
                const redRes = await redeemPromoSingle(acc.session, code);
                results.push({ phone, ...redRes });
            } catch (err) {
                results.push({ phone, ok: false, message: err.message });
            }
            await new Promise((r) => setTimeout(r, 2000)); // Safe delay per account
        }
        return res.json({ ok: true, results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 9. GROUP MODERATION API (BAN/UNBAN/MUTE) ----------------
app.post("/api/tg/moderate-user", async (req, res) => {
    const { action, chatId, userId } = req.body;
    if (!chatId || !userId || !action) return res.status(400).json({ ok: false, error: "Missing parameters" });

    try {
        if (action === "ban") {
            await groupBot.banChatMember(chatId, userId);
            return res.json({ ok: true, message: "User banned!" });
        } else if (action === "unban") {
            await groupBot.unbanChatMember(chatId, userId, { only_if_banned: true });
            return res.json({ ok: true, message: "User unbanned!" });
        } else if (action === "mute") {
            const until = Math.floor(Date.now() / 1000) + 3600;
            await groupBot.restrictChatMember(chatId, userId, {
                permissions: { can_send_messages: false },
                until_date: until
            });
            return res.json({ ok: true, message: "User muted for 1 hour!" });
        }
        return res.status(400).json({ ok: false, error: "Invalid action" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 10. USER NOTIFY HELPER (@Ppmod_bot) ----------------
// Gmail mask: last 3 chars visible (e.g. nahid123@gmail.com -> ++++++123@gmail.com). Password NEVER logged.
function maskGmail(email) {
    const e = (email || "").toString().trim();
    const at = e.lastIndexOf("@");
    if (at <= 1) return e ? "++++++" : "—";
    return "++++++" + e.slice(at - 3, at) + e.slice(at);
}
async function sendOrderLog(text) {
    if (!text) return;
    try {
        await fetch(`https://api.telegram.org/bot${USER_NOTIFY_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: ORDER_LOG_CHANNEL, text: text, parse_mode: "HTML" })
        });
    } catch (e) {}
}

// ---------------- AUTO REALISTIC ORDER LOG SIMULATOR (8 - 25 MIN RANDOM) ----------------
const POPULAR_GAMES_LOG = [
    "8ball pool (50)", "Angry birds 2 (50)", "Best Fiends (50)", "Dice dreams (50)",
    "Domino dreams (50)", "Farm heroes (50)", "Hey day (All)", "Lords mobile (50)",
    "Mobile legends (50)", "Summoners War (50)", "Fruit ninja (50)", "Zenless Zone Zero (50)",
    "War machines (50)", "Yalla Ludo (50)"
];
const EMAIL_SNIPPETS = ["has", "rak", "tan", "784", "902", "sh", "joy", "fah", "321", "nah", "kab", "551", "al", "sak", "619", "mim"];

function generateRealisticFakeLog() {
    const game = POPULAR_GAMES_LOG[Math.floor(Math.random() * POPULAR_GAMES_LOG.length)];
    const snip = EMAIL_SNIPPETS[Math.floor(Math.random() * EMAIL_SNIPPETS.length)];
    const maskedEmail = `++++++${snip}@gmail.com`;
    const elapsed = Math.floor(Math.random() * 6) + 6; // 6s to 11s realistic
    const trxId = "WLT-" + Math.random().toString(36).substring(2, 9).toUpperCase();

    return `✅ <b>TASK COMPLETED</b>\n\n` +
           `🎮 <b>Game:</b> ${game}\n` +
           `📧 <b>Gmail:</b> <code>${maskedEmail}</code>\n` +
           `⏱️ <b>Time:</b> ~${elapsed}s\n` +
           `🪙 <b>Coins:</b> 3\n` +
           `💳 <b>Method:</b> PP Coins\n` +
           `🔖 <b>TrxID:</b> <code>${trxId}</code>\n` +
           `📌 <b>Status:</b> Completed`;
}

function scheduleNextFakeOrderLog() {
    // ৮ থেকে ২৫ মিনিটের মধ্যে র‍্যান্ডম বিরতি
    const randomMinutes = Math.floor(Math.random() * (25 - 8 + 1)) + 8;
    const delayMs = randomMinutes * 60 * 1000;
    setTimeout(async () => {
        try {
            const fakeLog = generateRealisticFakeLog();
            await sendOrderLog(fakeLog);
        } catch (e) {}
        scheduleNextFakeOrderLog();
    }, delayMs);
}

async function getUserTgId(uid, fallback) {
    try {
        if (uid) {
            const uSnap = await db.collection("users").doc(uid).get();
            if (uSnap.exists) {
                const t = (uSnap.data().tgChatId || "").toString().trim();
                if (t) return t;
            }
        }
    } catch (e) {}
    return fallback || "";
}
async function notifyUserTelegram(chatId, text) {
    if (!chatId) return;
    try {
        const cleanChatId = chatId.toString().replace(/[^0-9]/g, "");
        if (cleanChatId.length >= 5) {
            const url = `https://api.telegram.org/bot${USER_NOTIFY_BOT_TOKEN}/sendMessage`;
            await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: cleanChatId, text: text, parse_mode: "HTML" })
            });
        }
    } catch (e) {}
}

function parseBotBalance(text) {
    if (!text) return null;
    const match = text.match(/(?:balance|new balance|current balance)\s*[:\-]?\s*(\d+)/i) 
               || text.match(/(\d+)\s*(?:tokens|token|🪙)/i);
    return match ? Number(match[1]) : null;
}

function extractPromptNumber(text) {
    if (!text) return null;
    const match = text.match(/(?:tap|number|code|select|press|number:)\s*[:\-]?\s*(\d{2})/i) 
               || text.match(/\b(\d{2})\b/);
    return match ? match[1] : null;
}

async function clickInlineButton(message, textPattern) {
    if (!message || !message.replyMarkup || !message.replyMarkup.rows) return false;
    for (const row of message.replyMarkup.rows) {
        for (const button of row.buttons) {
            if (button.text && button.text.toLowerCase().includes(textPattern.toLowerCase())) {
                try {
                    await message.click({ text: button.text });
                    return true;
                } catch (e) {}
            }
        }
    }
    return false;
}

async function getLatestBotMessage() {
    try {
        if (!currentClient) return null;
        const msgs = await currentClient.getMessages(TARGET_BOT, { limit: 1 });
        if (msgs && msgs.length > 0 && !msgs[0].out) return msgs[0];
    } catch (e) {}
    return null;
}

async function waitForCondition(checkFn, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const msg = await getLatestBotMessage();
        if (msg) {
            const res = checkFn(msg);
            if (res) return { msg, res };
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
}

async function getUsableTelegramClient() {
    const snap = await db.collection("tg_accounts").where("active", "==", true).get();
    const accounts = [];
    snap.forEach((d) => accounts.push({ id: d.id, ...d.data() }));

    const valid = accounts
        .sort((a, b) => (Number(b.balance || 0)) - (Number(a.balance || 0)))
        .find((a) => (a.balance === undefined || a.balance >= 3) && a.session);

    let sessionStr = "";
    let chosenPhone = "";

    if (valid) {
        sessionStr = valid.session;
        chosenPhone = valid.phone || valid.id;
    } else if (process.env.TELEGRAM_SESSION) {
        sessionStr = process.env.TELEGRAM_SESSION;
        chosenPhone = "Primary_Account";
    } else {
        throw new Error("NO_BALANCE");
    }

    if (currentClient && currentPhone === chosenPhone) return currentClient;

    if (currentClient) {
        try { await currentClient.disconnect(); } catch (e) {}
    }

    const client = new TelegramClient(new StringSession(sessionStr), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 10 });
    await client.connect();
    currentClient = client;
    currentPhone = chosenPhone;
    return currentClient;
}

async function refundOrder(orderId, uid, reason, userTgId = null) {
    try {
        await db.runTransaction(async (t) => {
            const ordRef = db.collection("orders").doc(orderId);
            const userRef = db.collection("users").doc(uid);
            const ordSnap = await t.get(ordRef);
            if (!ordSnap.exists) return;
            const ordData = ordSnap.data();
            if (ordData.status === "completed" || ordData.status === "refunded") return;

            const userSnap = await t.get(userRef);
            const curBal = userSnap.exists ? Number(userSnap.data().balance || 0) : 0;
            const refundAmt = Number(ordData.amount || 3);

            t.update(userRef, { balance: curBal + refundAmt });
            t.update(ordRef, {
                status: "refunded",
                adminMsg: `❌ ${reason} — আপনার ${refundAmt} PP Coins ওয়ালেটে ফেরত দেওয়া হয়েছে।`,
                refundedAt: admin.firestore.FieldValue.serverTimestamp(),
                botProcessing: false
            });
        });

        if (userTgId) {
            const notifyId = await getUserTgId(uid, userTgId);
            await notifyUserTelegram(notifyId,
                `❌ <b>অর্ডার রিফান্ড নোটিফিকেশন:</b>\n\n` +
                `🎮 <b>গেম:</b> Task\n` +
                `⚠️ <b>কারণ:</b> ${reason}\n` +
                `🪙 <b>রিফান্ড:</b> ৩টি PP Coins ওয়ালেটে ফেরত দেওয়া হয়েছে।`
            );
        }
        sendOrderLog(
            `❌ <b>ORDER REFUNDED</b>\n\n` +
            `⚠️ <b>কারণ:</b> ${reason}\n` +
            `🪙 <b>Coins:</b> refunded\n` +
            `🆔 <b>Order:</b> <code>${orderId}</code>\n` +
            `📌 <b>Status:</b> Refunded`
        );
    } catch (e) {}
}

async function processOrder(orderId, orderData) {
    if (activeOrders.has(orderId)) return;
    activeOrders.add(orderId);

    const startTime = Date.now();
    const orderRef = db.collection("orders").doc(orderId);

    try {
        await orderRef.update({ adminMsg: "সার্ভার কাজ শুরু করেছে। দয়া করে অপেক্ষা করুন...", botProcessing: true });
        
        let tg;
        try {
            tg = await getUsableTelegramClient();
        } catch (err) {
            if (err.message === "NO_BALANCE") {
                await refundOrder(orderId, orderData.uid, "সার্ভারে পর্যাপ্ত টোকেন না থাকায় অর্ডারটি রিফান্ড করা হলো।", orderData.userTgId);
                return;
            }
            throw err;
        }

        await tg.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });
        sendOrderLog(
            `🆕 <b>NEW ORDER</b>\n\n` +
            `🎮 <b>Game:</b> ${orderData.game || "Task"}\n` +
            `📧 <b>Gmail:</b> <code>${maskGmail(orderData.accEmail)}</code>\n` +
            `🪙 <b>Coins:</b> ${orderData.amount || 3}\n` +
            `💳 <b>Method:</b> ${orderData.method || "PP Coins"}\n` +
            `🔖 <b>TrxID:</b> <code>${orderData.trxId || orderId}</code>\n` +
            `📌 <b>Status:</b> Pending`
        );
        let found = await waitForCondition((m) => m.message && (m.message.includes("Available Chests") || m.message.includes("Select the desired chest")), 20000);
        if (!found) throw new Error("Bot chest menu timeout");

        const gameSearch = orderData.game.split("(")[0].trim().toLowerCase();
        let clicked = await clickInlineButton(found.msg, gameSearch);
        if (!clicked) clicked = await clickInlineButton(found.msg, gameSearch.split(" ")[0]);
        if (!clicked) throw new Error(`Chest "${orderData.game}" bot-e paowa jayni`);

        await new Promise((r) => setTimeout(r, 2000));
        let promptMsg = await getLatestBotMessage();
        if (promptMsg && (promptMsg.message.includes("Last account") || promptMsg.message.includes("Confirm deducting"))) {
            await clickInlineButton(promptMsg, "New account");
            await new Promise((r) => setTimeout(r, 2000));
        }

        const credText = `${orderData.accEmail.trim()}---${orderData.accPass.trim()}`;
        await orderRef.update({ adminMsg: "লগইন তথ্য পাঠানো হয়েছে। কনফার্মেশন চলছে..." });
        await tg.sendMessage(TARGET_BOT, { message: credText });

        let confirmFound = await waitForCondition((m) => {
            const txt = (m.message || "").toLowerCase();
            return txt.includes("confirm credentials & payment") || txt.includes("confirm and start quests");
        }, 25000);

        if (confirmFound) {
            await clickInlineButton(confirmFound.msg, "Confirm & Pay");
        }

        let completed = false;
        let attempts = 0;

        while (!completed && attempts < 50) {
            attempts++;
            await new Promise((r) => setTimeout(r, 2000));
            const curMsg = await getLatestBotMessage();
            if (!curMsg) continue;

            const text = (curMsg.message || "").toLowerCase();

            if (text.includes("captcha security check") || text.includes("captcha")) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google Captcha সমস্যা দেখা দিয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।", orderData.userTgId);
                return;
            }

            if (text.includes("google rejected sign-in") || text.includes("couldn't sign you in")) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google অ্যাকাউন্ট লগইন রিজেক্ট করেছে (No চাপা হয়েছে বা ভেরিফিকেশন ফেইল)।", orderData.userTgId);
                return;
            }

            if (text.includes("password error") || text.includes("incorrect password") || text.includes("wrong password")) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "ভুল পাসওয়ার্ড (Incorrect Password)", orderData.userTgId);
                return;
            }

            if (text.includes("sign-in confirmed from your phone") || text.includes("unlocking task")) {
                await orderRef.update({ adminMsg: "✅ আপনার ফোন থেকে লগইন সফল হয়েছে! টাস্ক আনলক করা হচ্ছে, অপেক্ষা করুন..." });
            }

            const promptNum = extractPromptNumber(curMsg.message);
            if (promptNum && !text.includes("completed") && !text.includes("confirmed from your phone")) {
                await orderRef.update({ adminMsg: `⚠️ আপনার ফোনে Google Prompt এসেছে! অনুগ্রহ করে নোটিফিকেশনে [ ${promptNum} ] নম্বরে ট্যাপ করে Yes দিন।` });
            }

            if (text.includes("all quests") || text.includes("completed!") || text.includes("claim your points")) {
                const elapsedSec = Math.round((Date.now() - startTime) / 1000);
                await orderRef.update({
                    status: "completed",
                    adminMsg: `অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉`,
                    timeElapsed: elapsedSec,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    botProcessing: false
                });

                if (orderData.userTgId || orderData.uid) {
                    const notifyId = await getUserTgId(orderData.uid, orderData.userTgId);
                    await notifyUserTelegram(notifyId,
                        `🎉 <b>টাস্ক সম্পন্ন হয়েছে! (Task Completed)</b>\n\n` +
                        `🎮 <b>গেম:</b> ${orderData.game}\n` +
                        `⏱️ <b>সময় লেগেছে:</b> ~${elapsedSec} সেকেন্ড\n` +
                        `🪙 <b>ফি:</b> ৩টি PP Coins\n\n` +
                        `🎁 এখনই আপনার Google Play Store > Play Points অপশনে গিয়ে পয়েন্ট ক্লেইম করুন! 🚀`
                    );
                }
                sendOrderLog(
                    `✅ <b>TASK COMPLETED</b>\n\n` +
                    `🎮 <b>Game:</b> ${orderData.game || "Task"}\n` +
                    `📧 <b>Gmail:</b> <code>${maskGmail(orderData.accEmail)}</code>\n` +
                    `⏱️ <b>Time:</b> ~${elapsedSec}s\n` +
                    `🪙 <b>Coins:</b> ${orderData.amount || 3}\n` +
                    `💳 <b>Method:</b> ${orderData.method || "PP Coins"}\n` +
                    `🔖 <b>TrxID:</b> <code>${orderData.trxId || orderId}</code>\n` +
                    `📌 <b>Status:</b> Completed`
                );
                completed = true;
                return;
            }
        }
        if (!completed) throw new Error("Bot login timeout");
    } catch (err) {
        await refundOrder(orderId, orderData.uid, err.message || "সার্ভার এরর", orderData.userTgId);
    } finally {
        activeOrders.delete(orderId);
    }
}

// ---------------- 11. ADVANCED GROUP GUARDIAN (@Vareonprotection_bot) ----------------
async function isGroupAdmin(chatId, userId) {
    try {
        const member = await groupBot.getChatMember(chatId, userId);
        return member.status === "creator" || member.status === "administrator";
    } catch (e) {
        return false;
    }
}

// গ্রুপে বট অ্যাড হলেই স্বয়ংক্রিয় রেজিস্টার
groupBot.on("my_chat_member", async (msg) => {
    try {
        const chat = msg.chat;
        if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
        const newStatus = msg.new_chat_member ? msg.new_chat_member.status : "";

        if (newStatus === "administrator" || newStatus === "member") {
            await db.collection("tg_groups").doc(chat.id.toString()).set({
                id: chat.id.toString(),
                title: chat.title || "Group",
                username: chat.username ? `@${chat.username}` : "Private",
                antiLink: true,
                antiVideo: true,
                antiForward: true,
                antiInbox: true,
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
    } catch (e) {}
});

// Linked-channel cache (own channel forwards must NOT be deleted)
const linkedCache = new Map();
async function getLinkedChatId(chatId) {
    if (linkedCache.has(chatId)) return linkedCache.get(chatId);
    try {
        const info = await groupBot.getChat(chatId);
        const lid = info && info.linked_chat_id ? String(info.linked_chat_id) : "";
        linkedCache.set(chatId, lid);
        return lid;
    } catch (e) { return ""; }
}

// গ্রুপ মেসেজ হ্যান্ডলার (ফরোয়ার্ড ব্লক + আসল গালি ডিটেক্ট + ৩-ওয়ার্নিং ব্যান)
groupBot.on("message", async (msg) => {
    try {
        if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;

        const chatId = msg.chat.id.toString();
        const msgId = msg.message_id;
        const fromUser = msg.from;
        if (!fromUser || fromUser.is_bot) return;

        const userId = fromUser.id.toString();
        const currentName = `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim();
        const currentUsername = fromUser.username ? `@${fromUser.username}` : "None";
        const text = (msg.text || msg.caption || "").trim();

        // গ্রুপ ডাটাবেজে অটো-সিঙ্ক
        db.collection("tg_groups").doc(chatId).set({
            id: chatId,
            title: msg.chat.title || "Group",
            username: msg.chat.username ? `@${msg.chat.username}` : "Private",
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});

        let groupConf = groupConfigs.get(chatId);
        if (!groupConf) {
            const gDoc = await db.collection("tg_groups").doc(chatId).get();
            groupConf = gDoc.exists ? gDoc.data() : { antiLink: true, antiForward: true, antiInbox: true, antiVideo: true };
            groupConfigs.set(chatId, groupConf);
        }

        const isAdmin = await isGroupAdmin(chatId, fromUser.id);

        if (!isAdmin) {
            // ১. শেয়ার ও ফরোয়ার্ড ব্লক (সকল প্রকার ফরোয়ার্ড ১০০% ডিটেক্ট)
            const isForwarded = Boolean(
                msg.forward_from ||
                msg.forward_from_chat ||
                msg.forward_sender_name ||
                msg.forward_origin ||
                msg.forward_date
            );

            if (groupConf.antiForward !== false && isForwarded) {
                let ownChannel = false;
                try {
                    const fwdChat = (msg.forward_origin && msg.forward_origin.type === "channel" && msg.forward_origin.chat)
                        ? msg.forward_origin.chat
                        : (msg.forward_from_chat || null);
                    if (fwdChat) {
                        const fid = (fwdChat.id !== undefined && fwdChat.id !== null) ? String(fwdChat.id) : "";
                        const fun = ((fwdChat.username || "").toString().toLowerCase().replace(/^@/, ""));
                        if (fid) {
                            const linked = await getLinkedChatId(chatId);
                            if (linked && fid === String(linked)) ownChannel = true;
                        }
                        if (!ownChannel && fun) {
                            const list = Array.isArray(groupConf.allowChannels) ? groupConf.allowChannels : [];
                            const norm = list.map((x) => (x || "").toString().toLowerCase().replace(/^@/, "").trim()).filter(Boolean);
                            if (norm.includes(fun)) ownChannel = true;
                        }
                    }
                } catch (e) {}
                if (ownChannel) return; // নিজেদের/অনুমোদিত চ্যানেলের পোস্ট — কোনো ফিল্টার চালবে না
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const fwdMsg = (groupConf.msgs && groupConf.msgs.forward) || "অন্য কোনো চ্যানেল, গ্রুপ বা ইনবক্স থেকে শেয়ার বা ফরোয়ার্ড করা সম্পূর্ণ নিষেধ!";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${fwdMsg}`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }

            // ২. ভিডিও ও ভিডিও নোট ব্লক
            if (groupConf.antiVideo && (msg.video || msg.video_note)) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const vidMsg = (groupConf.msgs && groupConf.msgs.video) || "গ্রুপে ভিডিও পাঠানো নিষেধ!";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${vidMsg}`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }

            // ৩. ইনবক্স ও বাইপাস ফিল্টার
            if (groupConf.antiInbox !== false) {
                for (const ib of INBOX_WORDS) {
                    if (text.toLowerCase().includes(ib.toLowerCase())) {
                        await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                        const ibMsg = (groupConf.msgs && groupConf.msgs.inbox) || "গ্রুপে ইনবক্সে ডাকার চেষ্টা করবেন না! সব কথা গ্রুপেই বলুন।";
                        const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${ibMsg}`, { parse_mode: "HTML" });
                        setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                        return;
                    }
                }
            }

            // ৪. অ্যান্টি-লিংক ফিল্টার
            if (groupConf.antiLink !== false && (text.includes("t.me/") || text.includes("http://") || text.includes("https://"))) {
                if (!text.includes("googleplaypointhack") && !text.includes("ppmod")) {
                    await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                    const linkMsg = (groupConf.msgs && groupConf.msgs.link) || "অননুমোদিত লিংক দেওয়া নিষেধ!";
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${linkMsg}`, { parse_mode: "HTML" });
                    setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                    return;
                }
            }

            // ৫. আসল গালি ফিল্টার ও ৩-ওয়ার্নিং ব্যান সিস্টেম!
            const cleanText = text.toLowerCase().replace(/[^a-zA-Z0-9\u0980-\u09FF]/g, "");
            let hasBadWord = false;

            for (const bad of REAL_BAD_WORDS) {
                if (text.toLowerCase().includes(bad) || cleanText.includes(bad)) {
                    hasBadWord = true;
                    break;
                }
            }

            if (hasBadWord) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const limit = Math.max(2, Number(groupConf.warnLimit) || 5);
                const action = groupConf.warnAction || "ban";
                const curWarns = (await getWarnCount(chatId, userId)) + 1;
                await setWarnCount(chatId, userId, curWarns);
                const atName = `@${fromUser.username || fromUser.first_name}`;

                if (curWarns >= limit) {
                    if (action === "mute") {
                        const until = Math.floor(Date.now() / 1000) + 3600;
                        await groupBot.restrictChatMember(chatId, userId, {
                            permissions: { can_send_messages: false }, until_date: until
                        }).catch(() => {});
                        await groupBot.sendMessage(chatId, `🔇 <b>${atName}</b>-কে <b>১ ঘণ্টার জন্য মিউট</b> করা হলো! (গালি: ${curWarns}/${limit})`, { parse_mode: "HTML" });
                    } else if (action === "warn") {
                        await groupBot.sendMessage(chatId, `🚨 <b>${atName}</b>, <b>শেষ ওয়ার্নিং (${curWarns}/${limit})!</b> ${groupConf.warnMsg || "এরপর কঠোর ব্যবস্থা নেওয়া হবে!"}`, { parse_mode: "HTML" });
                    } else {
                        await groupBot.banChatMember(chatId, userId).catch(() => {});
                        await groupBot.sendMessage(chatId, `🚨 <a href="tg://user?id=${userId}">${currentName}</a>-কে <b>গ্রুপ থেকে ব্যান</b> করা হলো! (গালি: ${curWarns}/${limit})`, { parse_mode: "HTML" });
                    }
                    await clearWarn(chatId, userId);
                } else {
                    const base = groupConf.warnMsg || "ভদ্র ভাষা ব্যবহার করুন!";
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>${atName}</b>, ${base} সতর্কতা <b>(${curWarns}/${limit})</b>।`, { parse_mode: "HTML" });
                    setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 5000);
                }
                return;
            }
        }

        // কাস্টম কি-ওয়ার্ড অটো-রিপ্লাই (ইনস্ট্যান্ট, কেস-ইনসেনসিটিভ ও বাটন-লিংক সাপোর্ট)
        if (groupConf.triggers && groupConf.triggers.length > 0) {
            const lowerText = text.toLowerCase().trim();
            for (const trig of groupConf.triggers) {
                const kw = (trig.keyword || "").toLowerCase().trim();
                if (kw && lowerText.includes(kw)) {
                    const sendOpts = {
                        reply_to_message_id: msgId,
                        parse_mode: "HTML"
                    };

                    // বাটন ও লিংক থাকলে ইনলাইন বাটন যুক্ত করা
                    if (trig.btnText && trig.btnUrl) {
                        sendOpts.reply_markup = {
                            inline_keyboard: [
                                [{ text: trig.btnText.trim(), url: trig.btnUrl.trim() }]
                            ]
                        };
                    }

                    // মেসেজ ইনস্ট্যান্ট পাঠানো (HTML এরর হলে প্লেইন টেক্সট হিসেবে পাঠানো)
                    groupBot.sendMessage(chatId, trig.reply, sendOpts).catch(() => {
                        delete sendOpts.parse_mode;
                        groupBot.sendMessage(chatId, trig.reply, sendOpts).catch(() => {});
                    });
                    break;
                }
            }
        }

        // SangMata Name Change Tracker
        const userDocRef = db.collection("tg_user_history").doc(userId);
        const userSnap = await userDocRef.get();

        if (userSnap.exists) {
            const oldData = userSnap.data();
            const oldName = oldData.name || "";
            const oldUsername = oldData.username || "";

            if (oldName !== currentName || oldUsername !== currentUsername) {
                const changeAlert = 
                    `🔄 <b>User Profile Changed!</b>\n\n` +
                    `👤 <b>User:</b> <a href="tg://user?id=${userId}">${currentName}</a> (<code>${userId}</code>)\n` +
                    `📝 <b>Name:</b> <code>${oldName}</code> ➔ <code>${currentName}</code>\n` +
                    `🔖 <b>Username:</b> <code>${oldUsername}</code> ➔ <code>${currentUsername}</code>`;

                await groupBot.sendMessage(chatId, changeAlert, { parse_mode: "HTML" }).catch(() => {});
                
                await userDocRef.set({
                    name: currentName,
                    username: currentUsername,
                    previousNames: admin.firestore.FieldValue.arrayUnion({ name: oldName, username: oldUsername, at: new Date() })
                }, { merge: true });
            }
        } else {
            await userDocRef.set({
                userId: userId, name: currentName, username: currentUsername, createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // পার্মানেন্ট স্ক্যামার চেক
        const scamSnap = await db.collection("tg_scammers").doc(userId).get();
        if (scamSnap.exists && scamSnap.data().isScammer) {
            const scammerWarning = 
                `🚨 <b>SCAMMER ALERT!</b>\n\n` +
                `⚠️ <a href="tg://user?id=${userId}">${currentName}</a> (<code>${userId}</code>) <b>একজন প্রমাণিত প্রতারক / স্ক্যামার!</b>\n` +
                `❌ এই ইউজারের সাথে কেউ কোনো প্রকার লেনদেন করবেন না!`;

            await groupBot.sendMessage(chatId, scammerWarning, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
        }

        // /scammer এবং /unscammer
        if (text.startsWith("/scammer") || text.startsWith("/unscammer")) {
            if (!isAdmin) {
                const warn = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, এই কমান্ড কেবল এডমিনদের জন্য!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                setTimeout(() => groupBot.deleteMessage(chatId, warn.message_id).catch(() => {}), 5000);
                return;
            }

            let targetUser = msg.reply_to_message ? msg.reply_to_message.from : null;
            if (!targetUser) {
                await groupBot.sendMessage(chatId, `💡 <b>ব্যবহার:</b> যাকে স্ক্যামার বানাবেন তাকে রিপ্লাই দিয়ে <code>/scammer</code> লিখুন।`, { parse_mode: "HTML", reply_to_message_id: msgId });
                return;
            }

            const targetId = targetUser.id.toString();
            const targetName = `${targetUser.first_name || ""} ${targetUser.last_name || ""}`.trim();

            if (text.startsWith("/scammer")) {
                await db.collection("tg_scammers").doc(targetId).set({
                    userId: targetId, name: targetName, username: targetUser.username ? `@${targetUser.username}` : "None",
                    isScammer: true, taggedBy: fromUser.id.toString(), taggedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                await groupBot.sendMessage(chatId, `🚨 <a href="tg://user?id=${targetId}">${targetName}</a>-কে চিরতরে <b>স্ক্যামার রেজিস্ট্রি করা হলো</b>!`, { parse_mode: "HTML", reply_to_message_id: msgId });
            } else {
                await db.collection("tg_scammers").doc(targetId).delete();
                await groupBot.sendMessage(chatId, `✅ <a href="tg://user?id=${targetId}">${targetName}</a>-কে স্ক্যামার লিস্ট থেকে মুক্ত করা হলো।`, { parse_mode: "HTML", reply_to_message_id: msgId });
            }
            return;
        }

    } catch (e) {
        console.error("[GROUP MSG ERR]:", e.message);
    }
});

// গ্রুপে নতুন মেম্বার ওয়েলকাম (পূর্বের মেসেজ অটো-ক্লিন)
groupBot.on("new_chat_members", async (msg) => {
    try {
        const chatId = msg.chat.id.toString();
        const newMembers = msg.new_chat_members || [];

        const oldMsgId = lastWelcomeMessages.get(chatId);
        if (oldMsgId) {
            await groupBot.deleteMessage(chatId, oldMsgId).catch(() => {});
        }

        let gConf = groupConfigs.get(chatId);
        if (!gConf) {
            try {
                const gDoc = await db.collection("tg_groups").doc(chatId).get();
                gConf = gDoc.exists ? gDoc.data() : {};
                groupConfigs.set(chatId, gConf);
            } catch (e) { gConf = {}; }
        }
        const gw = await getGlobalWelcome();
        if (gw.welcomeOn === false) return;

        for (const user of newMembers) {
            if (user.is_bot) continue;
            const name = user.first_name || "Member";
            const w = buildWelcome(gw, name);

            const sentWelcome = await groupBot.sendPhoto(chatId, w.img, {
                caption: w.text,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: w.buttons }
            }).catch(() => {});

            if (sentWelcome) {
                lastWelcomeMessages.set(chatId, sentWelcome.message_id);
                setTimeout(() => groupBot.deleteMessage(chatId, sentWelcome.message_id).catch(() => {}), 10000);
            }
        }
    } catch (e) {}
});

// Giveaway Join বাটন হ্যান্ডলার
groupBot.on("callback_query", async (query) => {
    try {
        const data = query.data;
        const fromUser = query.from;
        const chatId = query.message.chat.id;

        if (data.startsWith("giveaway_join:")) {
            const giveawayId = data.split(":")[1];
            const gRef = db.collection("giveaways").doc(giveawayId);
            const gSnap = await gRef.get();

            if (!gSnap.exists || gSnap.data().status === "ended") {
                return groupBot.answerCallbackQuery(query.id, { text: "এই গিভঅ্যাওয়ে ইতিমধ্যে শেষ হয়ে গেছে!", show_alert: true });
            }

            const participants = gSnap.data().participants || [];
            const alreadyJoined = participants.some((p) => p.id === fromUser.id.toString());

            if (alreadyJoined) {
                return groupBot.answerCallbackQuery(query.id, { text: "আপনি ইতিমধ্যে অংশগ্রহণ করেছেন!", show_alert: true });
            }

            participants.push({
                id: fromUser.id.toString(),
                name: `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim()
            });

            await gRef.update({ participants });
            await groupBot.answerCallbackQuery(query.id, { text: "🎉 সফলভাবে অংশগ্রহণ করেছেন! শুভকামনা।", show_alert: true });

            await groupBot.editMessageReplyMarkup({
                inline_keyboard: [
                    [{ text: `🎉 Join Giveaway [${participants.length}]`, callback_data: `giveaway_join:${giveawayId}` }]
                ]
            }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
            return;
        }

    } catch (e) {}
});

// ---------------- 12. REAL-TIME GROUP CONFIG SYNC ----------------
db.collection("tg_groups").onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
        const dat = change.doc.data();
        groupConfigs.set(change.doc.id, dat);
    });
});

// ---------------- 13. MASTER WORKER START ----------------
let botModeCache; // undefined = never configured -> keep processing (backward compatible)
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Master Guardian...");
    await initPrimeAutoResponder();
    db.collection("tg_accounts").onSnapshot(() => initPrimeAutoResponder());

    // Start 8-25 min realistic order log simulator
    scheduleNextFakeOrderLog();

    // Watch admin Bot Mode toggle: explicit OFF = skip auto-processing (manual mode)
    db.collection("config").doc("app").onSnapshot((snap) => {
        try {
            const d = snap.exists ? snap.data() : {};
            botModeCache = (d && d.botMode === undefined) ? undefined : !!(d && d.botMode);
            console.log("[CONFIG] botMode =", botModeCache);
        } catch (e) {}
    });

    try { await getUsableTelegramClient(); } catch (e) {}

    // Auto Daily Claim Scheduler (runs every 12 hours automatically)
    setInterval(async () => {
        try {
            console.log("[AUTO CLAIM] Starting scheduled daily rewards claim...");
            const snap = await db.collection("tg_accounts").where("active", "==", true).get();
            for (const docSnap of snap.docs) {
                const acc = docSnap.data();
                if (acc.session) {
                    await claimDailySingle(acc.session).catch(() => {});
                    await new Promise((r) => setTimeout(r, 3000));
                }
            }
            console.log("[AUTO CLAIM] Scheduled claim completed.");
        } catch (e) {}
    }, 12 * 60 * 60 * 1000);

    db.collection("orders").where("status", "==", "pending").onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added" || change.type === "modified") {
                const ord = change.doc.data();
                const ordId = change.doc.id;
                if (botModeCache === false) return; // manual mode: admin handles by hand
                if (ord.accEmail && ord.accPass && ord.mode !== "manual" && !ord.botProcessing && !activeOrders.has(ordId)) {
                    processOrder(ordId, ord);
                }
            }
        });
    });

    console.log("[MASTER INIT] Active!");
}

startMasterWorker().catch(console.error);