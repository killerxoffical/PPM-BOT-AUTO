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

// টেলিগ্রাম গ্রুপ প্রটেকশন বট (@Vareonprotection_bot)
const groupBot = new TelegramBot(GROUP_PROTECT_BOT_TOKEN, { polling: true });

// আপনার দেওয়া ওয়েলকাম ছবি ও ক্যাপশন
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
                if (now - lastTime < 3600000) return; // ১ ঘণ্টার কুলডাউন

                await new Promise((r) => setTimeout(r, 3500));
                await primeClient.sendMessage(sender.id, {
                    file: PRIME_AUTO_REPLY_IMG,
                    message: PRIME_AUTO_REPLY_CAPTION,
                    parseMode: "html"
                });
                autoReplyCooldown.set(senderId, now);
            } catch (err) {}
        }, new NewMessage({ incoming: true }));

        console.log(`[PRIME AUTO-REPLY] 24/7 Listener Active for: ${phone}`);
    } catch (e) {}
}

// ---------------- 5. FAST DIRECT OTP API ----------------
app.post("/api/tg/send-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    if (!phone || phone.length < 11) {
        return res.status(400).json({ ok: false, error: "সঠিক ফোন নম্বর দিন (যেমন: 017XXXXXXXX)" });
    }

    try {
        const tempClient = new TelegramClient(new StringSession(""), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
        await tempClient.connect();

        const result = await tempClient.sendCode({
            apiId: DEFAULT_API_ID,
            apiHash: DEFAULT_API_HASH
        }, phone);

        pendingAuthClients.set(phone, { client: tempClient, phoneCodeHash: result.phoneCodeHash });
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
    if (!item) return res.status(400).json({ ok: false, error: "সেশন মেয়াদ শেষ! আবার Send OTP দিন।" });

    try {
        try {
            await item.client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: item.phoneCodeHash,
                phoneCode: code
            }));
        } catch (signInErr) {
            if (signInErr.errorMessage === "SESSION_PASSWORD_NEEDED" || (signInErr.message && signInErr.message.includes("2FA"))) {
                if (!password) return res.status(400).json({ ok: false, error: "এই অ্যাকাউন্টে 2FA অন আছে! Two-Step পাসওয়ার্ড দিন।" });
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
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message });
    }
});

// ---------------- 6. REAL BALANCE AUDIT API ----------------
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
                        balance: b,
                        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
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
            botTokensTotal: totalBalance,
            botTokensLastSync: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, total: totalBalance, accounts: results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 7. USER NOTIFY HELPER (@Ppmod_bot) ----------------
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

// ---------------- 8. ADVANCED GROUP GUARDIAN & SANGMATA ENGINE (@Vareonprotection_bot) ----------------
const BAD_WORDS = ["gali1", "gali2", "scam", "fraud", "বা***", "চো***", "খা***", "মাদার***", "শালা", "খানকি"];

// গ্রুপ অ্যাডমিন চেক হেল্পার
async function isGroupAdmin(chatId, userId) {
    try {
        const member = await groupBot.getChatMember(chatId, userId);
        return member.status === "creator" || member.status === "administrator";
    } catch (e) {
        return false;
    }
}

// গ্রুপের মেসেজ মনিটরিং
groupBot.on("message", async (msg) => {
    try {
        if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;

        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const fromUser = msg.from;
        if (!fromUser || fromUser.is_bot) return;

        const userId = fromUser.id.toString();
        const currentName = `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim();
        const currentUsername = fromUser.username ? `@${fromUser.username}` : "None";
        const text = (msg.text || msg.caption || "").trim();

        // ১. গ্রুপ স্বয়ংক্রিয়ভাবে ডাটাবেজে রেজিস্টার ও আপডেট
        db.collection("tg_groups").doc(chatId.toString()).set({
            id: chatId.toString(),
            title: msg.chat.title || "Group",
            username: msg.chat.username ? `@${msg.chat.username}` : "Private",
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});

        // ২. SangMata Style: নাম বা ইউজারনেম পরিবর্তন ট্র্যাকার!
        const userDocRef = db.collection("tg_user_history").doc(userId);
        const userSnap = await userDocRef.get();

        if (userSnap.exists) {
            const oldData = userSnap.data();
            const oldName = oldData.name || "";
            const oldUsername = oldData.username || "";

            if (oldName !== currentName || oldUsername !== currentUsername) {
                // নাম বা ইউজারনেম পরিবর্তিত হয়েছে!
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
            // নতুন ইউজার ফার্স্ট টাইম সেভ
            await userDocRef.set({
                userId: userId,
                name: currentName,
                username: currentUsername,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // ৩. পার্মানেন্ট স্ক্যামার চেক (Scammer Tag Enforcement)
        const scamSnap = await db.collection("tg_scammers").doc(userId).get();
        if (scamSnap.exists && scamSnap.data().isScammer) {
            const scammerWarning = 
                `🚨 <b>SCAMMER ALERT!</b>\n\n` +
                `⚠️ <a href="tg://user?id=${userId}">${currentName}</a> (<code>${userId}</code>) <b>একজন প্রমাণিত প্রতারক / স্ক্যামার!</b>\n` +
                `❌ এই ইউজারের সাথে কেউ কোনো প্রকার লেনদেন বা কথা বলবেন না!\n` +
                `📌 <i>প্রতারক হিসেবে তালিকাভুক্ত করেছেন: এডমিন</i>`;

            await groupBot.sendMessage(chatId, scammerWarning, { 
                parse_mode: "HTML", 
                reply_to_message_id: msgId 
            }).catch(() => {});
        }

        // ৪. এডমিন কমান্ড: /scammer এবং /unscammer
        if (text.startsWith("/scammer") || text.startsWith("/unscammer")) {
            const isAdmin = await isGroupAdmin(chatId, fromUser.id);
            if (!isAdmin) {
                const warn = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, আপনি এই কমান্ডটি ব্যবহার করার অনুমতিপ্রাপ্ত নন!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                setTimeout(() => groupBot.deleteMessage(chatId, warn.message_id).catch(() => {}), 5000);
                return;
            }

            let targetUser = null;
            if (msg.reply_to_message && msg.reply_to_message.from) {
                targetUser = msg.reply_to_message.from;
            }

            if (!targetUser) {
                await groupBot.sendMessage(chatId, `💡 <b>ব্যবহারের নিয়ম:</b> যে প্রতারক তাকে রিপ্লাই দিয়ে <code>/scammer</code> লিখুন।`, { parse_mode: "HTML", reply_to_message_id: msgId });
                return;
            }

            const targetId = targetUser.id.toString();
            const targetName = `${targetUser.first_name || ""} ${targetUser.last_name || ""}`.trim();

            if (text.startsWith("/scammer")) {
                await db.collection("tg_scammers").doc(targetId).set({
                    userId: targetId,
                    name: targetName,
                    username: targetUser.username ? `@${targetUser.username}` : "None",
                    isScammer: true,
                    taggedBy: fromUser.id.toString(),
                    taggedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                await groupBot.sendMessage(chatId, `🚨 <b>সফল!</b> <a href="tg://user?id=${targetId}">${targetName}</a>-কে চিরতরে <b>স্ক্যামার লিস্টে যুক্ত করা হয়েছে</b>। সে মেসেজ দিলেই ওয়ার্নিং দেওয়া হবে!`, { parse_mode: "HTML", reply_to_message_id: msgId });
            } else if (text.startsWith("/unscammer")) {
                await db.collection("tg_scammers").doc(targetId).delete();
                await groupBot.sendMessage(chatId, `✅ <a href="tg://user?id=${targetId}">${targetName}</a>-কে স্ক্যামার লিস্ট থেকে মুক্ত করা হয়েছে।`, { parse_mode: "HTML", reply_to_message_id: msgId });
            }
            return;
        }

        // ৫. অ্যান্টি-লিংক ফিল্টার
        if (text.includes("t.me/") || text.includes("http://") || text.includes("https://")) {
            if (!text.includes("googleplaypointhack") && !text.includes("ppmod")) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, গ্রুপে অননুমোদিত লিংক দেওয়া নিষেধ!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }
        }

        // ৬. গালি ফিল্টার
        for (const bad of BAD_WORDS) {
            if (text.toLowerCase().includes(bad.toLowerCase())) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, গ্রুপে শালীন ভাষা ব্যবহার করুন!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }
        }

    } catch (e) {
        console.error("[GROUP MSG ERR]:", e.message);
    }
});

// গ্রুপে নতুন মেম্বার জয়েন করলে আপনার দেওয়া ছবিসহ ওয়েলকাম
groupBot.on("new_chat_members", async (msg) => {
    try {
        const chatId = msg.chat.id;
        const newMembers = msg.new_chat_members || [];

        for (const user of newMembers) {
            if (user.is_bot) continue;
            const name = user.first_name || "Member";
            const welcomeText = 
                `🎉 <b>স্বাগতম ${name}!</b>\n\n` +
                `আমাদের অফিসিয়াল গ্রুপে আপনাকে স্বাগতম। এখানে গুগল প্লে পয়েন্ট অটোমেশন সাপোর্ট ও রিয়েল-টাইম আপডেট পাবেন।\n\n` +
                `📢 <b>আমাদের চ্যানেল:</b> <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n` +
                `⚠️ <i>গ্রুপে যেকোনো স্ক্যামার থেকে সতর্ক থাকুন।</i>`;

            await groupBot.sendPhoto(chatId, WELCOME_IMG, {
                caption: welcomeText,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📢 Official Channel", url: "https://t.me/googleplaypointhack" }]
                    ]
                }
            }).catch(() => {});
        }
    } catch (e) {}
});

// ---------------- 9. MASTER WORKER START ----------------
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Automation & Security Suite...");

    await initPrimeAutoResponder();
    db.collection("tg_accounts").onSnapshot(() => initPrimeAutoResponder());

    try {
        await getUsableTelegramClient();
    } catch (e) {}

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

    console.log("[MASTER INIT] Groups & Workers Successfully Active!");
}

startMasterWorker().catch(console.error);