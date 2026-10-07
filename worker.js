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

let currentClient = null;
let currentPhone = null;
const activeOrders = new Set();
const autoReplyCooldown = new Map();
const pendingAuthClients = new Map(); // phone -> { client, phoneCodeHash }

// অটো +88 ফরম্যাট হেল্পার (ইউজার 01 দিলে অটো +8801 হবে)
function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) return "+" + num;
    if (num.startsWith("0")) return "+88" + num;
    if (num.startsWith("1")) return "+880" + num;
    return "+" + num;
}

// ---------------- 4. FAST DIRECT OTP API (FIXED WITH GramJS Api) ----------------
app.post("/api/tg/send-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    if (!phone || phone.length < 11) {
        return res.status(400).json({ ok: false, error: "সঠিক ফোন নম্বর দিন (যেমন: 017XXXXXXXX)" });
    }

    console.log(`[AUTH] Requesting OTP for formatted phone: ${phone}`);
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

        console.log(`[AUTH SUCCESS] OTP sent to Telegram: ${phone}`);
        return res.json({ ok: true, message: "OTP sent to Telegram!", phone: phone });
    } catch (err) {
        console.error(`[AUTH ERR]:`, err.message);
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
        // GramJS Official Method: Api.auth.SignIn
        try {
            await item.client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: item.phoneCodeHash,
                    phoneCode: code
                })
            );
        } catch (signInErr) {
            // যদি 2FA পাসওয়ার্ড চায়
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

        await db.collection("tg_accounts").doc(phone).set({
            phone: phone,
            session: sessionString,
            balance: 0,
            active: true,
            addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        pendingAuthClients.delete(phone);
        console.log(`[AUTH VERIFIED SUCCESS] Account ${phone} connected!`);
        return res.json({ ok: true, message: "Account connected successfully!" });
    } catch (err) {
        console.error(`[VERIFY ERR]:`, err);
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message || "ভেরিফিকেশন ফেইলড" });
    }
});

// ---------------- 5. REAL BOT BALANCE CHECK API ----------------
app.post("/api/tg/check-balance", async (req, res) => {
    console.log(`[FORCE BALANCE CHECK] Checking real tokens from PlayQuestHelperBot...`);
    try {
        const tg = await getUsableTelegramClient();
        await tg.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });

        let found = await waitForCondition((m) => {
            return (m.message && (m.message.includes("Available Chests") || m.message.includes("Select the desired chest") || m.message.includes("Balance")));
        }, 15000);

        if (found && found.msg) {
            const b = parseBotBalance(found.msg.message);
            if (b !== null) {
                await syncAccountBalance(currentPhone, b);
                return res.json({ ok: true, balance: b });
            }
        }
        return res.json({ ok: false, error: "বট থেকে ব্যালেন্স টেক্সট পাওয়া যায়নি" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 6. USER NOTIFICATION HELPER ----------------
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

async function syncAccountBalance(phone, balance) {
    if (balance === null || balance === undefined || isNaN(balance)) return;
    try {
        if (phone && phone !== "Primary_Account") {
            await db.collection("tg_accounts").doc(phone).set({
                balance: balance,
                lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        await db.collection("config").doc("app").set({
            botTokensTotal: balance,
            botTokensLastSync: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {}
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

// ---------------- 7. TELEGRAM WORKER CLIENT ROTATION ----------------
async function getUsableTelegramClient() {
    const snap = await db.collection("tg_accounts").where("active", "==", true).get();
    const accounts = [];
    snap.forEach((d) => accounts.push({ id: d.id, ...d.data() }));

    const valid = accounts
        .sort((a, b) => (b.isPrime ? 1 : 0) - (a.isPrime ? 1 : 0))
        .find((a) => (a.balance === undefined || a.balance >= 3) && a.session);

    let sessionStr = "";
    let chosenPhone = "";
    let isPrime = false;

    if (valid) {
        sessionStr = valid.session;
        chosenPhone = valid.phone || valid.id;
        isPrime = !!valid.isPrime;
    } else if (process.env.TELEGRAM_SESSION) {
        sessionStr = process.env.TELEGRAM_SESSION;
        chosenPhone = "Primary_Account";
        isPrime = true;
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

    console.log(`[CLIENT INIT] Active worker: ${chosenPhone} (Prime: ${isPrime})`);
    return currentClient;
}

// ---------------- 8. REFUND LOGIC ----------------
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

// ---------------- 9. MASTER ORDER PROCESSOR ----------------
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

        // ধাপ ১: Start Process
        await tg.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });

        let found = await waitForCondition((m) => m.message && (m.message.includes("Available Chests") || m.message.includes("Select the desired chest")), 20000);
        if (!found) throw new Error("Bot chest menu timeout");

        const curBal = parseBotBalance(found.msg.message);
        if (curBal !== null) syncAccountBalance(currentPhone, curBal);

        // ধাপ ২: গেম বাটন ক্লিক
        const gameSearch = orderData.game.split("(")[0].trim().toLowerCase();
        let clicked = await clickInlineButton(found.msg, gameSearch);
        if (!clicked) clicked = await clickInlineButton(found.msg, gameSearch.split(" ")[0]);
        if (!clicked) throw new Error(`Chest "${orderData.game}" bot-e paowa jayni`);

        // ধাপ ৩: New Account
        await new Promise((r) => setTimeout(r, 2000));
        let promptMsg = await getLatestBotMessage();
        if (promptMsg && (promptMsg.message.includes("Last account") || promptMsg.message.includes("Confirm deducting"))) {
            await clickInlineButton(promptMsg, "New account");
            await new Promise((r) => setTimeout(r, 2000));
        }

        // ধাপ ৪: ক্রেডেনশিয়াল পাঠানো
        const credText = `${orderData.accEmail.trim()}---${orderData.accPass.trim()}`;
        console.log(`[CREDENTIALS] Sending: ${orderData.accEmail}---******`);
        await orderRef.update({ adminMsg: "লগইন তথ্য পাঠানো হয়েছে। কনফার্মেশন চলছে..." });

        await tg.sendMessage(TARGET_BOT, { message: credText });

        // ধাপ ৫: Confirm & Pay
        let confirmFound = await waitForCondition((m) => {
            const txt = (m.message || "").toLowerCase();
            return txt.includes("confirm credentials & payment") || txt.includes("confirm and start quests");
        }, 25000);

        if (confirmFound) {
            console.log(`[BOT CLICK] Confirm & Pay`);
            const payBal = parseBotBalance(confirmFound.msg.message);
            if (payBal !== null) syncAccountBalance(currentPhone, payBal);
            await clickInlineButton(confirmFound.msg, "Confirm & Pay");
        }

        // ধাপ ৬: লাইভ মনিটরিং
        let completed = false;
        let attempts = 0;

        while (!completed && attempts < 50) {
            attempts++;
            await new Promise((r) => setTimeout(r, 2000));
            const curMsg = await getLatestBotMessage();
            if (!curMsg) continue;

            const text = (curMsg.message || "").toLowerCase();
            const b = parseBotBalance(curMsg.message);
            if (b !== null) syncAccountBalance(currentPhone, b);

            // Captcha Error
            if (text.includes("captcha security check") || text.includes("captcha")) {
                console.log(`[CAPTCHA DETECTED] Google Captcha error!`);
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google Captcha সমস্যা দেখা দিয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।", orderData.userTgId);
                return;
            }

            // Google Rejected
            if (text.includes("google rejected sign-in") || text.includes("couldn't sign you in")) {
                console.log(`[REJECTED] Google rejected sign-in`);
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google অ্যাকাউন্ট লগইন রিজেক্ট করেছে (No চাপা হয়েছে বা ভেরিফিকেশন ফেইল)।", orderData.userTgId);
                return;
            }

            // Password Error
            if (text.includes("password error") || text.includes("incorrect password") || text.includes("wrong password")) {
                console.log(`[PASSWORD ERROR] Wrong password`);
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "ভুল পাসওয়ার্ড (Incorrect Password)", orderData.userTgId);
                return;
            }

            // Login Confirmed
            if (text.includes("sign-in confirmed from your phone") || text.includes("unlocking task")) {
                console.log(`[LOGIN CONFIRMED] Phone confirmed, unlocking quests...`);
                await orderRef.update({
                    adminMsg: "✅ আপনার ফোন থেকে লগইন সফল হয়েছে! টাস্ক আনলক করা হচ্ছে, অপেক্ষা করুন..."
                });
            }

            // Prompt Number
            const promptNum = extractPromptNumber(curMsg.message);
            if (promptNum && !text.includes("completed") && !text.includes("confirmed from your phone")) {
                const promptNotice = `⚠️ আপনার ফোনে Google Prompt এসেছে! অনুগ্রহ করে নোটিফিকেশনে [ ${promptNum} ] নম্বরে ট্যাপ করে Yes দিন।`;
                await orderRef.update({ adminMsg: promptNotice });
            }

            // Quest Completed
            if (text.includes("all quests") || text.includes("completed!") || text.includes("claim your points")) {
                const elapsedSec = Math.round((Date.now() - startTime) / 1000);
                console.log(`[SUCCESS] Quest Completed in ${elapsedSec}s!`);
                
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

// ---------------- 10. GROUP PROTECTION BOT ----------------
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

// ---------------- 11. START WORKER ----------------
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Automation & Security Suite...");

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