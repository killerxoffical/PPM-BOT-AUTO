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

app.get("/", (req, res) => res.status(200).send("PP MOD Master Worker Active!"));
app.get("/ping", (req, res) => res.status(200).send("pong"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

app.listen(PORT, () => console.log(`[HTTP] Server active on port ${PORT}`));

// ---------------- 2. FIREBASE ADMIN INITIALIZATION ----------------
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

// 🌟 আপনার দেওয়া ছবি ও মেসেজ
const PRIME_AUTO_REPLY_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791345238749_file_000000003d348211a5a894b5cf98d67c.png";
const PRIME_AUTO_REPLY_CAPTION = `👋 <b>হ্যালো!</b>\n\nএডমিন অনলাইনে আসলে আপনার মেসেজের রিপ্লাই দেওয়া হবে। আপনার কী প্রয়োজন তা দয়া করে নিচে বিস্তারিত লিখে রাখুন।\n\n📢 <b>আমাদের অফিশিয়াল চ্যানেলে যুক্ত থাকুন:</b>\n👉 <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n\nধন্যবাদ! ✨`;

let currentClient = null;
let currentPhone = null;
let primeClient = null;
let primePhone = null;

const activeOrders = new Set();
const autoReplyCooldown = new Map(); // senderId -> timestamp
const pendingAuthClients = new Map(); // phone -> { client, phoneCodeHash }

function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) return "+" + num;
    if (num.startsWith("0")) return "+88" + num;
    if (num.startsWith("1")) return "+880" + num;
    return "+" + num;
}

// ---------------- 4. 24/7 DEDICATED PRIME ACCOUNT AUTO-RESPONDER ----------------
async function initPrimeAutoResponder() {
    try {
        const snap = await db.collection("tg_accounts").where("isPrime", "==", true).limit(1).get();
        if (snap.empty) {
            console.log("[PRIME] No Prime account designated yet.");
            return;
        }

        const primeData = snap.docs[0].data();
        const phone = primeData.phone || snap.docs[0].id;

        if (primeClient && primePhone === phone) {
            return; // Already running
        }

        if (primeClient) {
            try { await primeClient.disconnect(); } catch (e) {}
        }

        console.log(`[PRIME AUTO-REPLY] Initializing 24/7 Listener for Prime Account: ${phone}`);
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

                // ১ ঘণ্টার কুলডাউন
                if (now - lastTime < 3600000) return;

                console.log(`[PRIME DM] Message from ${sender.firstName || senderId}. Replying in 3.5s...`);
                await new Promise((r) => setTimeout(r, 3500));

                await primeClient.sendMessage(sender.id, {
                    file: PRIME_AUTO_REPLY_IMG,
                    message: PRIME_AUTO_REPLY_CAPTION,
                    parseMode: "html"
                });

                autoReplyCooldown.set(senderId, now);
                console.log(`[PRIME DM SENT] Successfully sent auto-reply to ${sender.firstName || senderId}`);
            } catch (err) {
                console.error("[PRIME DM ERR]:", err.message);
            }
        }, new NewMessage({ incoming: true }));

        console.log(`[PRIME AUTO-REPLY] Active & Listening 24/7 for: ${phone}`);
    } catch (e) {
        console.error("[PRIME INIT ERR]:", e.message);
    }
}

// ---------------- 5. FAST DIRECT OTP API ----------------
app.post("/api/tg/send-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    if (!phone || phone.length < 11) {
        return res.status(400).json({ ok: false, error: "সঠিক ফোন নম্বর দিন (যেমন: 017XXXXXXXX)" });
    }

    console.log(`[AUTH] Requesting OTP for: ${phone}`);
    try {
        const tempClient = new TelegramClient(new StringSession(""), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
        await tempClient.connect();

        const result = await tempClient.sendCode({
            apiId: DEFAULT_API_ID,
            apiHash: DEFAULT_API_HASH
        }, phone);

        pendingAuthClients.set(phone, {
            client: tempClient,
            phoneCodeHash: result.phoneCodeHash
        });

        return res.json({ ok: true, message: "OTP sent to Telegram!", phone: phone });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

app.post("/api/tg/verify-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    const code = (req.body.code || "").toString().trim();
    const password = (req.body.password || "").toString().trim();

    const item = pendingAuthClients.get(phone);
    if (!item) {
        return res.status(400).json({ ok: false, error: "সেশন মেয়াদ শেষ! আবার Send OTP দিন।" });
    }

    try {
        try {
            await item.client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: item.phoneCodeHash,
                    phoneCode: code
                })
            );
        } catch (signInErr) {
            if (signInErr.errorMessage === "SESSION_PASSWORD_NEEDED" || (signInErr.message && signInErr.message.includes("2FA"))) {
                if (!password) {
                    return res.status(400).json({ ok: false, error: "এই অ্যাকাউন্টে 2FA অন আছে! Two-Step পাসওয়ার্ড দিন।" });
                }
                if (typeof item.client.checkPassword === "function") {
                    await item.client.checkPassword(password);
                } else if (typeof item.client.signInUserWithPassword === "function") {
                    await item.client.signInUserWithPassword({ apiId: DEFAULT_API_ID, apiHash: DEFAULT_API_HASH, password: password });
                } else {
                    const pwd = await item.client.invoke(new Api.account.GetPassword());
                    const { computeCheck } = require("telegram/Password");
                    const passwordHash = await computeCheck(pwd, password);
                    await item.client.invoke(new Api.auth.CheckPassword({ password: passwordHash }));
                }
            } else {
                throw signInErr;
            }
        }

        const sessionString = item.client.session.save();

        // অ্যাকাউন্ট সেভ করা
        await db.collection("tg_accounts").doc(phone).set({
            phone: phone,
            session: sessionString,
            balance: 0,
            active: true,
            addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        pendingAuthClients.delete(phone);
        return res.json({ ok: true, message: "Account connected successfully!" });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message || "ভেরিফিকেশন ফেইলড" });
    }
});

// ---------------- 6. REAL BALANCE CHECK (LOOPS EVERY CONNECTED ACCOUNT) ----------------
app.post("/api/tg/check-balance", async (req, res) => {
    console.log(`[FULL BALANCE AUDIT] Checking real tokens for ALL pool accounts...`);
    try {
        const snap = await db.collection("tg_accounts").get();
        if (snap.empty) {
            return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট পুলে যুক্ত নেই" });
        }

        let totalBalance = 0;
        const results = [];

        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            try {
                console.log(`[AUDIT] Checking bot balance for: ${phone}...`);
                const tempClient = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
                await tempClient.connect();

                await tempClient.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });
                await new Promise((r) => setTimeout(r, 2500));

                const msgs = await tempClient.getMessages(TARGET_BOT, { limit: 1 });
                let b = null;
                if (msgs && msgs.length > 0) {
                    b = parseBotBalance(msgs[0].message);
                }

                if (b !== null) {
                    await db.collection("tg_accounts").doc(docSnap.id).update({
                        balance: b,
                        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    totalBalance += b;
                    results.push({ phone, balance: b });
                    console.log(`[AUDIT RESULT] ${phone} -> ${b} Tokens!`);
                } else {
                    results.push({ phone, balance: acc.balance || 0 });
                }

                await tempClient.disconnect();
            } catch (err) {
                console.error(`[AUDIT ERR] ${phone}:`, err.message);
                results.push({ phone, balance: acc.balance || 0, error: err.message });
            }
        }

        // মেইন ব্যালেন্স আপডেট
        await db.collection("config").doc("app").set({
            botTokensTotal: totalBalance,
            botTokensLastSync: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, total: totalBalance, accounts: results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 7. USER NOTIFICATION HELPER ----------------
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
            console.log(`[USER NOTIFY] Sent via @Ppmod_bot to: ${cleanChatId}`);
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
                console.log(`[BOT CLICK] "${button.text}"`);
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

// ---------------- 8. TELEGRAM WORKER CLIENT ROTATION ----------------
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

    if (currentClient && currentPhone === chosenPhone) {
        return currentClient;
    }

    if (currentClient) {
        try { await currentClient.disconnect(); } catch (e) {}
    }

    const client = new TelegramClient(new StringSession(sessionStr), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 10 });
    await client.connect();
    currentClient = client;
    currentPhone = chosenPhone;

    console.log(`[CLIENT INIT] Active worker: ${chosenPhone}`);
    return currentClient;
}

// ---------------- 9. REFUND LOGIC ----------------
async function refundOrder(orderId, uid, reason, userTgId = null) {
    console.log(`[REFUND] Order ${orderId}: ${reason}`);
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
                `🪙 <b>রিফান্ড:</b> ৩টি PP Coins আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে।\n\n` +
                `👉 দয়া করে সঠিক তথ্য দিয়ে পুনরায় চেষ্টা করুন।`
            );
        }
    } catch (e) {}
}

// ---------------- 10. MASTER ORDER PROCESSOR ----------------
async function processOrder(orderId, orderData) {
    if (activeOrders.has(orderId)) return;
    activeOrders.add(orderId);

    const startTime = Date.now();
    console.log(`\n========================================`);
    console.log(`[TASK START] ID: ${orderId} | Game: ${orderData.game} | ${orderData.accEmail}`);
    console.log(`========================================`);

    const orderRef = db.collection("orders").doc(orderId);

    try {
        await orderRef.update({ adminMsg: "সার্ভার কাজ শুরু করেছে। দয়া করে অপেক্ষা করুন...", botProcessing: true });
        
        let tg;
        try {
            tg = await getUsableTelegramClient();
        } catch (err) {
            if (err.message === "NO_BALANCE") {
                await refundOrder(orderId, orderData.uid, "সার্ভারে পর্যাপ্ত টোকেন না থাকায় অর্ডারটি রিফান্ড করা হলো। কিছুক্ষণ পর চেষ্টা করুন।", orderData.userTgId);
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
        console.log(`[CREDENTIALS] Sending: ${orderData.accEmail}---******`);
        await orderRef.update({ adminMsg: "লগইন তথ্য পাঠানো হয়েছে। কনফার্মেশন চলছে..." });

        await tg.sendMessage(TARGET_BOT, { message: credText });

        let confirmFound = await waitForCondition((m) => {
            const txt = (m.message || "").toLowerCase();
            return txt.includes("confirm credentials & payment") || txt.includes("confirm and start quests");
        }, 25000);

        if (confirmFound) {
            console.log(`[BOT CLICK] Confirm & Pay`);
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
                await orderRef.update({
                    adminMsg: "✅ আপনার ফোন থেকে লগইন সফল হয়েছে! টাস্ক আনলক করা হচ্ছে, অপেক্ষা করুন..."
                });
            }

            const promptNum = extractPromptNumber(curMsg.message);
            if (promptNum && !text.includes("completed") && !text.includes("confirmed from your phone")) {
                const promptNotice = `⚠️ আপনার ফোনে Google Prompt এসেছে! অনুগ্রহ করে নোটিফিকেশনে [ ${promptNum} ] নম্বরে ট্যাপ করে Yes দিন।`;
                await orderRef.update({ adminMsg: promptNotice });
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
        console.error(`[ERROR] Order ${orderId}:`, err.message);
        await refundOrder(orderId, orderData.uid, err.message || "সার্ভার এরর", orderData.userTgId);
    } finally {
        activeOrders.delete(orderId);
    }
}

// ---------------- 11. GROUP PROTECTION BOT ----------------
const BAD_WORDS = ["gali1", "gali2", "scam", "fraud", "বা***", "চো***", "খা***", "মাদার***", "শালা", "খানকি"];

groupBot.on("message", async (msg) => {
    try {
        if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const text = msg.text || msg.caption || "";

        if (text.includes("t.me/") || text.includes("http://") || text.includes("https://")) {
            if (!text.includes("googleplaypointhack") && !text.includes("ppmod")) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${msg.from.username || msg.from.first_name}</b>, গ্রুপে অননুমোদিত লিংক দেওয়া নিষেধ!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 5000);
                return;
            }
        }

        for (const bad of BAD_WORDS) {
            if (text.toLowerCase().includes(bad.toLowerCase())) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${msg.from.username || msg.from.first_name}</b>, ভদ্র ভাষা ব্যবহার করুন!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 5000);
                return;
            }
        }

        if (text.toLowerCase().includes("coin") || text.toLowerCase().includes("কয়েন")) {
            await groupBot.sendMessage(chatId, `🪙 <b>PP Coins কেনার নিয়ম:</b>\nআমাদের ওয়েবসাইটে লগইন করে Wallet অপশন থেকে bKash/Nagad দিয়ে সরাসরি Coins অ্যাড করতে পারেন।`, { parse_mode: "HTML", reply_to_message_id: msgId });
        }
    } catch (e) {}
});

// ---------------- 12. MASTER WORKER START ----------------
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Automation & Security Suite...");

    // প্রাইম অ্যাকাউন্ট ২৪/৭ অটো-রেসপন্ডার চালু করা
    await initPrimeAutoResponder();

    // প্রাইম পরিবর্তনের রিয়েল-টাইম লিসেনার
    db.collection("tg_accounts").onSnapshot(() => {
        initPrimeAutoResponder();
    });

    try {
        await getUsableTelegramClient();
    } catch (e) {
        console.log(`[INIT NOTICE] ${e.message}`);
    }

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
    }, (err) => console.error("[FIRESTORE ERR]:", err.message));

    console.log("[MASTER INIT] Listening for Orders & Group Messages Successfully!");
}

startMasterWorker().catch(console.error);