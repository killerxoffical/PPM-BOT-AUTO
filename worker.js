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
app.get("/", (req, res) => res.status(200).send("PP MOD Master Engine & Group Guardian Active!"));
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

const groupBot = new TelegramBot(GROUP_PROTECT_BOT_TOKEN, { polling: true });

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
const userSlowdownTracker = new Map(); // "chatId:userId" -> timestamp
const lastWelcomeMessages = new Map(); // chatId -> messageId

// ইনবক্স ও বাইপাস ফিল্টার শব্দ
const INBOX_WORDS = ["inbox", "ib", "dm me", "pm me", "message me", "msg me", "আমায় মেসেজ করো", "ইনবক্সে আসো", "ইনবক্স", "ইনবক্সে", "নক দাও", "নক দিন", "পার্সোনালে আসো"];
const BAD_WORDS = ["gali1", "gali2", "scam", "fraud", "বা***", "চো***", "খা***", "মাদার***", "শালা", "খানকি"];

function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) return "+" + num;
    if (num.startsWith("0")) return "+88" + num;
    if (num.startsWith("1")) return "+880" + num;
    return "+" + num;
}

// ---------------- 4. BROADCAST TO ALL GROUPS API ----------------
app.post("/api/tg/group-broadcast", async (req, res) => {
    const { text, photoUrl } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: "মেসেজ লিখুন" });

    try {
        const snap = await db.collection("tg_groups").get();
        let successCount = 0;

        for (const d of snap.docs) {
            const chatId = d.id;
            try {
                if (photoUrl) {
                    await groupBot.sendPhoto(chatId, photoUrl, { caption: text, parse_mode: "HTML" });
                } else {
                    await groupBot.sendMessage(chatId, text, { parse_mode: "HTML" });
                }
                successCount++;
            } catch (err) {}
        }
        return res.json({ ok: true, message: `${successCount} টি গ্রুপে ব্রডকাস্ট পাঠানো হয়েছে!` });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 5. GIVEAWAY MANAGEMENT API ----------------
app.post("/api/tg/create-giveaway", async (req, res) => {
    const { chatId, prize, winnersCount } = req.body;
    if (!chatId || !prize) return res.status(400).json({ ok: false, error: "Missing fields" });

    try {
        const giveawayRef = await db.collection("giveaways").add({
            chatId,
            prize,
            winnersCount: Number(winnersCount || 1),
            participants: [],
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const gMsg = await groupBot.sendMessage(chatId, 
            `🎉 <b>ধামাকা গিভঅ্যাওয়ে শুরু হয়েছে! (GIVEAWAY)</b>\n\n` +
            `🎁 <b>পুরস্কার:</b> ${prize}\n` +
            `🏆 <b>বিজয়ী নির্বাচন:</b> ${winnersCount} জন\n\n` +
            `👇 নিচের বাটনে ক্লিক করে এখনই অংশগ্রহণ করুন!`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `🎉 Join Giveaway [অংশগ্রহণকারী: 0]`, callback_data: `giveaway_join:${giveawayRef.id}` }]
                    ]
                }
            }
        );

        await giveawayRef.update({ messageId: gMsg.message_id });
        return res.json({ ok: true, message: "গিভঅ্যাওয়ে গ্রুপে শুরু হয়েছে!", giveawayId: giveawayRef.id });
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
            await groupBot.sendMessage(g.chatId, `⚠️ <b>গিভঅ্যাওয়ে সমাপ্ত:</b> কোনো অংশগ্রহণকারী পাওয়া যায়নি।`, { parse_mode: "HTML" });
            await gDoc.ref.update({ status: "ended" });
            return res.json({ ok: true, message: "No participants" });
        }

        // র্যান্ডম বিজয়ী নির্বাচন
        const shuffled = participants.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, Math.min(g.winnersCount, participants.length));

        let winnerText = `🏆 <b>গিভঅ্যাওয়ে বিজয়ীদের তালিকা! (WINNERS)</b>\n\n🎁 <b>পুরস্কার:</b> ${g.prize}\n\n`;
        winners.forEach((w, idx) => {
            winnerText += `🥇 <b>Winner ${idx + 1}:</b> <a href="tg://user?id=${w.id}">${w.name}</a> (<code>${w.id}</code>)\n`;
        });
        winnerText += `\n🎉 অভিনন্দন সবাইকে! এডমিনের সাথে যোগাযোগ করে পুরস্কার সংগ্রহ করুন।`;

        await groupBot.sendMessage(g.chatId, winnerText, { parse_mode: "HTML" });
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
                const now = Date.now();
                const lastTime = autoReplyCooldown.get(senderId) || 0;
                if (now - lastTime < 3600000) return;

                await new Promise((r) => setTimeout(r, 3500));
                await primeClient.sendMessage(sender.id, {
                    file: PRIME_AUTO_REPLY_IMG,
                    message: PRIME_AUTO_REPLY_CAPTION,
                    parseMode: "html"
                });
                autoReplyCooldown.set(senderId, now);
            } catch (err) {}
        }, new NewMessage({ incoming: true }));
    } catch (e) {}
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

app.post("/api/tg/verify-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    const code = (req.body.code || "").toString().trim();
    const password = (req.body.password || "").toString().trim();

    const item = pendingAuthClients.get(phone);
    if (!item) return res.status(400).json({ ok: false, error: "সেশন মেয়াদ শেষ!" });

    try {
        try {
            await item.client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: item.phoneCodeHash, phoneCode: code }));
        } catch (signInErr) {
            if (signInErr.errorMessage === "SESSION_PASSWORD_NEEDED" || (signInErr.message && signInErr.message.includes("2FA"))) {
                if (!password) return res.status(400).json({ ok: false, error: "Two-Step পাসওয়ার্ড দিন" });
                if (typeof item.client.checkPassword === "function") {
                    await item.client.checkPassword(password);
                } else {
                    await item.client.signInUserWithPassword({ apiId: DEFAULT_API_ID, apiHash: DEFAULT_API_HASH, password });
                }
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
            await notifyUserTelegram(userTgId, 
                `❌ <b>অর্ডার রিফান্ড নোটিফিকেশন:</b>\n\n` +
                `🎮 <b>গেম:</b> Task\n` +
                `⚠️ <b>কারণ:</b> ${reason}\n` +
                `🪙 <b>রিফান্ড:</b> ৩টি PP Coins ওয়ালেটে ফেরত দেওয়া হয়েছে।`
            );
        }
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
                    adminMsg: `অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉 (⏱️ সময় লেগেছে: ~${elapsedSec} সেকেন্ড)`,
                    timeElapsed: elapsedSec,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    botProcessing: false
                });

                if (orderData.userTgId) {
                    await notifyUserTelegram(orderData.userTgId,
                        `🎉 <b>টাস্ক সম্পন্ন হয়েছে! (Task Completed)</b>\n\n` +
                        `🎮 <b>গেম:</b> ${orderData.game}\n` +
                        `⏱️ <b>সময় লেগেছে:</b> ~${elapsedSec} সেকেন্ড\n` +
                        `🪙 <b>ফি:</b> ৩টি PP Coins\n\n` +
                        `🎁 এখনই আপনার Google Play Store > Play Points অপশনে গিয়ে পয়েন্ট ক্লেইম করুন! 🚀`
                    );
                }
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

// ---------------- 11. ADVANCED GROUP GUARDIAN & SANGMATA ENGINE (@Vareonprotection_bot) ----------------
async function isGroupAdmin(chatId, userId) {
    try {
        const member = await groupBot.getChatMember(chatId, userId);
        return member.status === "creator" || member.status === "administrator";
    } catch (e) {
        return false;
    }
}

// চ্যানেল ফোর্স জয়েন চেক হেল্পার
async function checkChannelJoined(channelId, userId) {
    try {
        const member = await groupBot.getChatMember(channelId, userId);
        return ["creator", "administrator", "member"].includes(member.status);
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
                slowMode30s: false,
                forceJoinEnabled: false,
                forceChannels: [],
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
    } catch (e) {}
});

// গ্রুপ মেসেজ হ্যান্ডলার
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

        // গ্রুপের কাস্টম কনফিগ রিড
        let groupConf = groupConfigs.get(chatId);
        if (!groupConf) {
            const gDoc = await db.collection("tg_groups").doc(chatId).get();
            groupConf = gDoc.exists ? gDoc.data() : { antiLink: true, antiForward: true, antiInbox: true };
            groupConfigs.set(chatId, groupConf);
        }

        const isAdmin = await isGroupAdmin(chatId, fromUser.id);

        // অ্যাডমিনদের ক্ষেত্রে ফিল্টার ছাড় দেওয়া
        if (!isAdmin) {
            // ১. FORCE JOIN (চ্যানেলে জয়েন না থাকলে চ্যাট লক)
            if (groupConf.forceJoinEnabled && groupConf.forceChannels && groupConf.forceChannels.length > 0) {
                for (const ch of groupConf.forceChannels) {
                    const isJoined = await checkChannelJoined(ch, fromUser.id);
                    if (!isJoined) {
                        await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                        const lockNotice = await groupBot.sendMessage(chatId,
                            `🔒 <b>চ্যাট লক করা হয়েছে!</b>\n\n` +
                            `স্বাগতম <a href="tg://user?id=${userId}">${currentName}</a>! গ্রুপে মেসেজ দিতে হলে আপনাকে প্রথমে আমাদের অফিসিয়াল চ্যানেলে জয়েন করতে হবে।`,
                            {
                                parse_mode: "HTML",
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: "📢 Join Channel", url: `https://t.me/${ch.replace('@', '')}` }],
                                        [{ text: "✅ Verify & Unlock Chat", callback_data: `verify_fsub:${ch}:${userId}` }]
                                    ]
                                }
                            }
                        );
                        setTimeout(() => groupBot.deleteMessage(chatId, lockNotice.message_id).catch(() => {}), 15000);
                        return;
                    }
                }
            }

            // ২. ৩০ সেকেন্ড স্লো-মোড রেট লিমিট
            if (groupConf.slowMode30s) {
                const slowKey = `${chatId}:${userId}`;
                const now = Date.now();
                const lastMsgTime = userSlowdownTracker.get(slowKey) || 0;
                if (now - lastMsgTime < 30000) {
                    await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                    const remSec = Math.ceil((30000 - (now - lastMsgTime)) / 1000);
                    const sm = await groupBot.sendMessage(chatId, `⏳ <b>@${fromUser.username || fromUser.first_name}</b>, স্লো-মোড চালু আছে! আরও ${remSec} সেকেন্ড পর মেসেজ দিতে পারবেন।`, { parse_mode: "HTML" });
                    setTimeout(() => groupBot.deleteMessage(chatId, sm.message_id).catch(() => {}), 4000);
                    return;
                }
                userSlowdownTracker.set(slowKey, now);
            }

            // ৩. অন্য চ্যানেল/গ্রুপ থেকে ফরোয়ার্ড বা শেয়ার ব্লক
            if (groupConf.antiForward !== false && (msg.forward_from || msg.forward_from_chat)) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, অন্য চ্যানেল বা গ্রুপ থেকে মেসেজ ফরোয়ার্ড করা নিষেধ!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }

            // ৪. ভিডিও ও ভিডিও নোট ব্লক
            if (groupConf.antiVideo && (msg.video || msg.video_note)) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, গ্রুপে ভিডিও পাঠানো নিষেধ!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }

            // ৫. ইনবক্স ও বাইপাস ফিল্টার (ib, inbox, আমায় মেসেজ করো ইত্যাদি)
            if (groupConf.antiInbox !== false) {
                for (const ib of INBOX_WORDS) {
                    if (text.toLowerCase().includes(ib.toLowerCase())) {
                        await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                        const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, গ্রুপে ইনবক্সে ডাকার চেষ্টা করবেন না! সব কথা গ্রুপেই বলুন।`, { parse_mode: "HTML" });
                        setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                        return;
                    }
                }
            }

            // ৬. অ্যান্টি-লিংক ফিল্টার
            if (groupConf.antiLink !== false && (text.includes("t.me/") || text.includes("http://") || text.includes("https://"))) {
                if (!text.includes("googleplaypointhack") && !text.includes("ppmod")) {
                    await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, গ্রুপে অননুমোদিত লিংক দেওয়া নিষেধ!`, { parse_mode: "HTML" });
                    setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                    return;
                }
            }

            // ৭. গালি ফিল্টার
            for (const bad of BAD_WORDS) {
                if (text.toLowerCase().includes(bad.toLowerCase())) {
                    await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, গ্রুপে শালীন ভাষা ব্যবহার করুন!`, { parse_mode: "HTML" });
                    setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                    return;
                }
            }
        }

        // কাস্টম কি-ওয়ার্ড অটো-রিপ্লাই
        if (groupConf.triggers && groupConf.triggers.length > 0) {
            for (const trig of groupConf.triggers) {
                if (trig.keyword && text.toLowerCase().includes(trig.keyword.toLowerCase())) {
                    await groupBot.sendMessage(chatId, trig.reply, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
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

        // /scammer এবং /unscammer এডমিন কমান্ড
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

// গ্রুপে নতুন মেম্বার জয়েন করলে ওয়েলকাম (পূর্বের ওয়েলকাম মেসেজ অটো-ক্লিন হবে)
groupBot.on("new_chat_members", async (msg) => {
    try {
        const chatId = msg.chat.id.toString();
        const newMembers = msg.new_chat_members || [];

        // পূর্বের ওয়েলকাম মেসেজ ডিলিট (যাতে চ্যাট পরিষ্কার থাকে)
        const oldMsgId = lastWelcomeMessages.get(chatId);
        if (oldMsgId) {
            await groupBot.deleteMessage(chatId, oldMsgId).catch(() => {});
        }

        for (const user of newMembers) {
            if (user.is_bot) continue;
            const name = user.first_name || "Member";
            const welcomeText = 
                `🎉 <b>স্বাগতম ${name}!</b>\n\n` +
                `আমাদের অফিসিয়াল গ্রুপে আপনাকে স্বাগতম। এখানে গুগল প্লে পয়েন্ট অটোমেশন সাপোর্ট ও রিয়েল-টাইম আপডেট পাবেন।\n\n` +
                `📢 <b>আমাদের চ্যানেল:</b> <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n` +
                `⚠️ <i>গ্রুপে যেকোনো স্ক্যামার থেকে সতর্ক থাকুন।</i>`;

            const sentWelcome = await groupBot.sendPhoto(chatId, WELCOME_IMG, {
                caption: welcomeText,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[{ text: "📢 Official Channel", url: "https://t.me/googleplaypointhack" }]]
                }
            }).catch(() => {});

            if (sentWelcome) {
                lastWelcomeMessages.set(chatId, sentWelcome.message_id);
            }
        }
    } catch (e) {}
});

// Callback Query (Giveaway Join & Force Subscribe Verify)
groupBot.on("callback_query", async (query) => {
    try {
        const data = query.data;
        const fromUser = query.from;
        const chatId = query.message.chat.id;

        // ১. Force Subscribe Verify বাটন
        if (data.startsWith("verify_fsub:")) {
            const [, channel, targetUserId] = data.split(":");
            if (fromUser.id.toString() !== targetUserId) {
                return groupBot.answerCallbackQuery(query.id, { text: "এটি আপনার জন্য নয়!", show_alert: true });
            }

            const isJoined = await checkChannelJoined(channel, fromUser.id);
            if (isJoined) {
                await groupBot.deleteMessage(chatId, query.message.message_id).catch(() => {});
                await groupBot.answerCallbackQuery(query.id, { text: "✅ ভেরিফিকেশন সফল! আপনার চ্যাট আনলক হয়েছে।", show_alert: true });
            } else {
                await groupBot.answerCallbackQuery(query.id, { text: "❌ আপনি এখনো চ্যানেলে জয়েন করেননি! আগে জয়েন করুন।", show_alert: true });
            }
            return;
        }

        // ২. Giveaway Join বাটন
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

            // বাটনের কাউন্টার আপডেট
            await groupBot.editMessageReplyMarkup({
                inline_keyboard: [
                    [{ text: `🎉 Join Giveaway [অংশগ্রহণকারী: ${participants.length}]`, callback_data: `giveaway_join:${giveawayId}` }]
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
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Suite with Group Guardian...");
    await initPrimeAutoResponder();
    db.collection("tg_accounts").onSnapshot(() => initPrimeAutoResponder());

    try { await getUsableTelegramClient(); } catch (e) {}

    db.collection("orders").where("status", "==", "pending").onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added" || change.type === "modified") {
                const ord = change.doc.data();
                const ordId = change.doc.id;
                if (ord.accEmail && ord.accPass && !ord.botProcessing && !activeOrders.has(ordId)) {
                    processOrder(ordId, ord);
                }
            }
        });
    });

    console.log("[MASTER INIT] Groups & Workers Live!");
}

startMasterWorker().catch(console.error);