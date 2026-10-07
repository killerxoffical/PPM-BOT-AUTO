require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// ---------------- 1. EXPRESS HTTP SERVER (RENDER 24/7 KEEP-ALIVE) ----------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("PP MOD Master Worker & Group Protector is Running 24/7!"));
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

// ---------------- 3. CONFIGURATIONS & BOT TOKENS ----------------
const DEFAULT_API_ID = Number(process.env.TELEGRAM_API_ID || 29630945);
const DEFAULT_API_HASH = process.env.TELEGRAM_API_HASH || "11b73fd133a7e3edea8d683aec494d3e";
const TARGET_BOT = process.env.TARGET_BOT || "PlayQuestHelperBot";

// ১. ইউজার প্রাইভেট নোটিফিকেশন বট (@Ppmod_bot)
const USER_NOTIFY_BOT_TOKEN = process.env.USER_NOTIFY_BOT_TOKEN || "8906230491:AAEu4CX0T9Dz6YMLxeCNz6U-nbiQmiBiJ_s";

// ২. গ্রুপ প্রটেকশন ও মডারেশন বট (@Vareonprotection_bot)
const GROUP_PROTECT_BOT_TOKEN = process.env.GROUP_PROTECT_BOT_TOKEN || "8590481969:AAFezVtaNE6D0QF0ss26k2SHj5tW7hCiSN8";
const groupBot = new TelegramBot(GROUP_PROTECT_BOT_TOKEN, { polling: true });

// DM Auto-Responder সেটিংস (প্রাইম অ্যাকাউন্টের জন্য)
const AUTO_REPLY_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791182445338_Google_Play_Points_Logo_2024_s2560__1_.png";
const AUTO_REPLY_CAPTION = `👋 <b>Welcome to PP MOD Automation!</b>\n\nআমরা গুগল প্লে পয়েন্ট ও কোয়েস্ট আনলক সার্ভিসের অটোমেশন প্রোভাইডার।\n\n📢 <b>আমাদের অফিসিয়াল চ্যানেল:</b>\n👉 <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n\nযেকোনো আপডেট পেতে চ্যানেলে যুক্ত থাকুন। ধন্যবাদ! ✨`;

let currentClient = null;
let currentPhone = null;
const activeOrders = new Set();
const autoReplyCooldown = new Map(); // senderId -> timestamp
const pendingAuthClients = new Map(); // phone -> { client, phoneCodeHash }

// ---------------- 4. USER TELEGRAM NOTIFICATION (@Ppmod_bot) ----------------
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
    } catch (e) {
        console.log(`[USER NOTIFY ERR]:`, e.message);
    }
}

// ---------------- 5. BOT TOKEN & BALANCE PARSER ----------------
function parseBotBalance(text) {
    if (!text) return null;
    const match = text.match(/(?:balance|new balance|current balance)\s*[:\-]?\s*(\d+)/i) 
               || text.match(/(\d+)\s*(?:tokens|token|🪙)/i);
    return match ? Number(match[1]) : null;
}

async function syncAccountBalance(phone, balance) {
    if (balance === null || balance === undefined || isNaN(balance)) return;
    console.log(`[BALANCE SYNC] Account ${phone || "Current"}: ${balance} Tokens`);
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

// ---------------- 6. MULTI-ACCOUNT ROTATION & AUTO-REPLY ENGINE ----------------
async function getUsableTelegramClient() {
    const snap = await db.collection("tg_accounts").where("active", "==", true).get();
    const accounts = [];
    snap.forEach((d) => accounts.push({ id: d.id, ...d.data() }));

    // ৩ বা তার বেশি টোকেন আছে এমন অ্যাকাউন্ট খোঁজা (প্রাইম অ্যাকাউন্ট আগে প্রাধান্য পাবে)
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

    // শুধু প্রাইম অ্যাকাউন্টেই ইনবক্স অটো-রিপ্লাই সচল থাকবে
    if (isPrime) {
        setupAutoReply(currentClient, chosenPhone);
    }

    console.log(`[CLIENT INIT] Active worker: ${chosenPhone} (Prime: ${isPrime})`);
    return currentClient;
}

function setupAutoReply(client, phone) {
    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg || msg.out || !event.isPrivate) return;
            const sender = await msg.getSender();
            if (!sender || sender.bot) return;

            const senderId = sender.id.toString();
            const now = Date.now();
            const lastTime = autoReplyCooldown.get(senderId) || 0;
            if (now - lastTime < 3600000) return; // ১ ঘণ্টার কুলডাউন

            const delay = Math.floor(Math.random() * 2000) + 3000;
            await new Promise((r) => setTimeout(r, delay));

            await client.sendMessage(sender.id, {
                file: AUTO_REPLY_IMG,
                message: AUTO_REPLY_CAPTION,
                parseMode: "html"
            });
            autoReplyCooldown.set(senderId, now);
            console.log(`[AUTO-REPLY] Sent promo to ${sender.firstName || senderId}`);
        } catch (e) {}
    }, new NewMessage({ incoming: true }));
}

// ---------------- 7. REFUND & CANCEL LOGIC ----------------
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

        // @Ppmod_bot দিয়ে ইউজারকে নোটিফিকেশন পাঠানো
        if (userTgId) {
            await notifyUserTelegram(userTgId, 
                `❌ <b>অর্ডার রিফান্ড নোটিফিকেশন:</b>\n\n` +
                `🎮 <b>গেম:</b> Task\n` +
                `⚠️ <b>কারণ:</b> ${reason}\n` +
                `🪙 <b>রিফান্ড:</b> ৩টি PP Coins আপনার অ্যাকাউন্টে ফেরত দেওয়া হয়েছে।\n\n` +
                `👉 দয়া করে সঠিক তথ্য দিয়ে পুনরায় চেষ্টা করুন।`
            );
        }
    } catch (e) {
        console.error(`[REFUND ERR]`, e.message);
    }
}

// ---------------- 8. MASTER ORDER PROCESSOR ----------------
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

        // ধাপ ৩: New Account নির্বাচন
        await new Promise((r) => setTimeout(r, 2000));
        let promptMsg = await getLatestBotMessage();
        if (promptMsg && (promptMsg.message.includes("Last account") || promptMsg.message.includes("Confirm deducting"))) {
            await clickInlineButton(promptMsg, "New account");
            await new Promise((r) => setTimeout(r, 2000));
        }

        // ধাপ ৪: ক্রেডেনশিয়াল পাঠানো: email---password
        const credText = `${orderData.accEmail.trim()}---${orderData.accPass.trim()}`;
        console.log(`[CREDENTIALS] Sending: ${orderData.accEmail}---******`);
        await orderRef.update({ adminMsg: "লগইন তথ্য পাঠানো হয়েছে। কনফার্মেশন চলছে..." });

        await tg.sendMessage(TARGET_BOT, { message: credText });

        // ধাপ ৫: Confirm & Pay (3 🪙) ✅ ক্লিক
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

            // কেস ১: Google Captcha Security Check
            if (text.includes("captcha security check") || text.includes("captcha")) {
                console.log(`[CAPTCHA DETECTED] Google Captcha error!`);
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google Captcha সমস্যা দেখা দিয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।", orderData.userTgId);
                return;
            }

            // কেস ২: Google rejected sign-in / Couldn't sign you in
            if (text.includes("google rejected sign-in") || text.includes("couldn't sign you in")) {
                console.log(`[REJECTED] Google rejected sign-in`);
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google অ্যাকাউন্ট লগইন রিজেক্ট করেছে (No চাপা হয়েছে বা ভেরিফিকেশন ফেইল)।", orderData.userTgId);
                return;
            }

            // কেস ৩: Password Error
            if (text.includes("password error") || text.includes("incorrect password") || text.includes("wrong password")) {
                console.log(`[PASSWORD ERROR] Wrong password`);
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "ভুল পাসওয়ার্ড (Incorrect Password)", orderData.userTgId);
                return;
            }

            // কেস ৪: ফোন থেকে লগইন কনফার্ম হওয়া
            if (text.includes("sign-in confirmed from your phone") || text.includes("unlocking task")) {
                console.log(`[LOGIN CONFIRMED] Phone confirmed, unlocking quests...`);
                await orderRef.update({
                    adminMsg: "✅ আপনার ফোন থেকে লগইন সফল হয়েছে! টাস্ক আনলক করা হচ্ছে, অপেক্ষা করুন..."
                });
            }

            // কেস ৫: Google Prompt Number চ্যালেঞ্জ (যেমন Tap 28)
            const promptNum = extractPromptNumber(curMsg.message);
            if (promptNum && !text.includes("completed") && !text.includes("confirmed from your phone")) {
                const promptNotice = `⚠️ আপনার ফোনে Google Prompt এসেছে! অনুগ্রহ করে নোটিফিকেশনে [ ${promptNum} ] নম্বরে ট্যাপ করে Yes দিন।`;
                await orderRef.update({ adminMsg: promptNotice });
            }

            // কেস ৬: কাজ সম্পূর্ণ হওয়া!
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

                // @Ppmod_bot দিয়ে ইউজারকে অভিনন্দন নোটিফিকেশন
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

// ---------------- 9. GROUP PROTECTION ENGINE (@Vareonprotection_bot) ----------------
const BAD_WORDS = ["gali1", "gali2", "scam", "fraud", "বা***", "চো***", "খা***", "মাদার***", "শালা", "খানকি"];

groupBot.on("message", async (msg) => {
    try {
        if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;

        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const text = msg.text || msg.caption || "";

        // ১. অ্যান্টি-লিংক ফিল্টার (অননুমোদিত লিংক ডিলিট)
        if (text.includes("t.me/") || text.includes("http://") || text.includes("https://")) {
            if (!text.includes("googleplaypointhack") && !text.includes("ppmod")) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${msg.from.username || msg.from.first_name}</b>, গ্রুপে অননুমোদিত লিংক দেওয়া নিষেধ!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 5000);
                return;
            }
        }

        // ২. গালি ও খারাপ শব্দ ফিল্টার
        for (const bad of BAD_WORDS) {
            if (text.toLowerCase().includes(bad.toLowerCase())) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${msg.from.username || msg.from.first_name}</b>, ভদ্র ভাষা ব্যবহার করুন!`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 5000);
                return;
            }
        }

        // ৩. কি-ওয়ার্ড অটো-রিপ্লাই
        if (text.toLowerCase().includes("coin") || text.toLowerCase().includes("কয়েন")) {
            await groupBot.sendMessage(chatId, `🪙 <b>PP Coins কেনার নিয়ম:</b>\nআমাদের ওয়েবসাইটে লগইন করে Wallet অপশন থেকে bKash/Nagad দিয়ে সরাসরি Coins অ্যাড করতে পারেন।`, { parse_mode: "HTML", reply_to_message_id: msgId });
        }
    } catch (e) {}
});

groupBot.on("new_chat_members", async (msg) => {
    try {
        const name = msg.new_chat_members[0].first_name;
        await groupBot.sendMessage(msg.chat.id, 
            `👋 স্বাগতম <b>${name}</b> আমাদের অফিসিয়াল গ্রুপে!\nএখানে আপনি প্লে পয়েন্ট অটোমেশন সাপোর্ট ও আপডেট পাবেন।`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📢 Official Channel", url: "https://t.me/googleplaypointhack" }]
                    ]
                }
            }
        );
    } catch (e) {}
});

// ---------------- 10. REAL-TIME FIRESTORE ORDER & AUTH LISTENER ----------------
function listenAuthRequests() {
    db.collection("tg_auth_requests").where("status", "in", ["request_otp", "verify_otp"]).onSnapshot((snap) => {
        snap.docChanges().forEach(async (change) => {
            if (change.type === "added" || change.type === "modified") {
                const reqData = change.doc.data();
                const reqId = change.doc.id;
                const docRef = db.collection("tg_auth_requests").doc(reqId);

                if (reqData.status === "request_otp" && !reqData.processing) {
                    await docRef.update({ processing: true });
                    const phone = reqData.phone.replace(/[^0-9+]/g, "");
                    try {
                        const tempClient = new TelegramClient(new StringSession(""), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
                        await tempClient.connect();
                        const res = await tempClient.sendCode({ apiId: DEFAULT_API_ID, apiHash: DEFAULT_API_HASH }, phone);
                        pendingAuthClients.set(phone, { client: tempClient, phoneCodeHash: res.phoneCodeHash });
                        await docRef.update({ status: "otp_sent", phoneCodeHash: res.phoneCodeHash, processing: false });
                    } catch (err) {
                        await docRef.update({ status: "error", processing: false, error: err.message });
                    }
                }

                if (reqData.status === "verify_otp" && !reqData.processing) {
                    await docRef.update({ processing: true });
                    const phone = reqData.phone.replace(/[^0-9+]/g, "");
                    const code = (reqData.code || "").trim();
                    const password = (reqData.password || "").trim();
                    const item = pendingAuthClients.get(phone);
                    if (!item) {
                        await docRef.update({ status: "error", error: "Session expired" });
                        return;
                    }

                    try {
                        await item.client.signIn({ phoneNumber: phone, phoneCodeHash: item.phoneCodeHash, phoneCode: code });
                        const sessionString = item.client.session.save();
                        await db.collection("tg_accounts").doc(phone).set({ phone: phone, session: sessionString, balance: 0, active: true, addedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
                        await docRef.update({ status: "success", processing: false });
                        pendingAuthClients.delete(phone);
                    } catch (err) {
                        if (err.message && (err.message.includes("PASSWORD_HASH_INVALID") || err.message.includes("2FA"))) {
                            try {
                                await item.client.signInWithPassword({ apiId: DEFAULT_API_ID, apiHash: DEFAULT_API_HASH }, { password: password });
                                const sessionString = item.client.session.save();
                                await db.collection("tg_accounts").doc(phone).set({ phone: phone, session: sessionString, balance: 0, active: true, addedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
                                await docRef.update({ status: "success", processing: false });
                                pendingAuthClients.delete(phone);
                                return;
                            } catch (pErr) {
                                await docRef.update({ status: "error", error: "Invalid 2FA Password" });
                                return;
                            }
                        }
                        await docRef.update({ status: "error", error: err.message });
                    }
                }
            }
        });
    });
}

async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Automation & Security Suite...");
    listenAuthRequests();

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